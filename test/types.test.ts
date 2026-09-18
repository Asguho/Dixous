import {
  createContextKey,
  createDixous,
  defineExtension,
  type Context,
  type ContextKey,
  type FetchResponse,
} from "../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const retry = defineExtension<
  { retry?: { attempts: number } },
  { retryDefaults?: { attempts: number } }
>()({
  async request(context, next) {
    const attempts: number | undefined = context.options.retry?.attempts;
    const defaults: number | undefined = context.client.retryDefaults?.attempts;
    void [attempts, defaults];
    // @ts-expect-error Request options are immutable.
    context.options.method = "POST";
    // @ts-expect-error Client options are immutable.
    context.client.baseUrl = "https://example.com";
    // @ts-expect-error Only the request is replaceable.
    context.state = {};
    context.request = new Request(context.request);
    return next();
  },
});

const methods = defineExtension({
  methods: {
    json: (fetchResponse: FetchResponse) => async <T>(
      schema: { parse(value: unknown): T },
    ): Promise<T> => schema.parse(await (await fetchResponse()).json()),
    text: (fetchResponse: FetchResponse) => async (prefix = "") =>
      prefix + await (await fetchResponse()).text(),
  },
});

const auth = defineExtension<{}, { auth?: { token: string } }>()({
  async request(context, next) {
    if (context.client.auth) {
      context.request.headers.set("authorization", context.client.auth.token);
    }
    return next();
  },
});

const dixous = createDixous({ extensions: [retry, methods, auth] });
const client = dixous({
  baseUrl: "https://example.com",
  retryDefaults: { attempts: 3 },
  auth: { token: "token" },
});
const pending = client.fetch("/users", {
  retry: { attempts: 2 },
  method: "GET",
  signal: new AbortController().signal,
});
const json = pending.json({ parse: () => ({ name: "Ada" }) });
const text = pending.text("prefix");
type JsonResult = Expect<Equal<typeof json, Promise<{ name: string }>>>;
type TextResult = Expect<Equal<typeof text, Promise<string>>>;

// @ts-expect-error Schema is required.
pending.json();
// @ts-expect-error Method arguments retain their types.
pending.text(123);
// @ts-expect-error Methods are readonly.
pending.text = async () => "replacement";
// @ts-expect-error Only registered methods exist.
pending.bytes();
// @ts-expect-error Unknown request options are rejected.
client.fetch("/users", { unknownOption: true });
// @ts-expect-error Request contribution has the declared type.
client.fetch("/users", { retry: { attempts: "three" } });
// @ts-expect-error Unknown client options are rejected.
dixous({ auth: { token: 42 } });

const empty = createDixous();
empty({ baseUrl: "https://example.com" }).fetch("/");
// @ts-expect-error There are no built-in response methods.
empty.fetch("https://example.com").json();
// @ts-expect-error Unregistered options are unavailable.
empty.fetch("https://example.com", { retry: {} });

// @ts-expect-error Request extensions cannot override native fields.
defineExtension<{ headers: string }>();
// @ts-expect-error Native fields remain reserved even with matching types.
defineExtension<{ method?: string }>();
// @ts-expect-error Client extensions cannot override core fields.
defineExtension<{}, { baseUrl: URL }>();
// @ts-expect-error Client headers are reserved.
defineExtension<{}, { headers?: HeadersInit }>();

declare const context: Context;
const numberKey = createContextKey<number>();
const stringKey = createContextKey<string>();
context.set(numberKey, 3);
const value = context.get(numberKey);
type ContextValue = Expect<Equal<typeof value, number | undefined>>;
// @ts-expect-error Context values must match their key.
context.set(numberKey, "three");
// @ts-expect-error Keys are invariant, preventing unsafe writes via widening.
const wider: ContextKey<number | string> = numberKey;
// @ts-expect-error Unbranded symbols are not context keys.
context.get(Symbol());
// @ts-expect-error Differently typed keys cannot be substituted.
const wrongKey: typeof numberKey = stringKey;

// Also exercise default generics and contributions with required fields.
defineExtension()({});
const required = defineExtension<{ feature: boolean }, { service: string }>()({});
const requiredClient = createDixous({ extensions: [required, methods] });
requiredClient({ service: "test" }).fetch("https://example.com", { feature: true });
// @ts-expect-error Supplied configuration must include required contributions.
requiredClient({});
// @ts-expect-error Supplied options must include required contributions.
requiredClient.fetch("https://example.com", {});
