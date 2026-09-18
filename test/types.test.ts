import type { StandardSchemaV1 } from "@standard-schema/spec";
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
    parsed: (fetchResponse) => {
      type InferredFetchResponse = Expect<Equal<typeof fetchResponse, FetchResponse>>;
      return async <T>(schema: { parse(value: unknown): T }): Promise<T> =>
        schema.parse(await (await fetchResponse()).json());
    },
    prefixed: (fetchResponse) => async (prefix = "") =>
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
const json = pending.parsed({ parse: () => ({ name: "Ada" }) });
const text = pending.prefixed("prefix");
type JsonResult = Expect<Equal<typeof json, Promise<{ name: string }>>>;
type TextResult = Expect<Equal<typeof text, Promise<string>>>;

// @ts-expect-error Inferred custom methods preserve required arguments.
pending.parsed();
// @ts-expect-error Inferred custom methods preserve argument types.
pending.prefixed(123);

const configuredMethods = defineExtension<
  { trace?: boolean },
  { traceLabel?: string }
>()({
  async request(context, next) {
    type TraceOption = Expect<Equal<typeof context.options.trace, boolean | undefined>>;
    type TraceLabel = Expect<Equal<typeof context.client.traceLabel, string | undefined>>;
    return next();
  },
  methods: {
    decoded(fetchResponse) {
      type InferredFetchResponse = Expect<Equal<typeof fetchResponse, FetchResponse>>;
      return async <T>(decode: (response: Response) => T) => {
        const response = await fetchResponse();
        type InferredResponse = Expect<Equal<typeof response, Response>>;
        // @ts-expect-error The inferred factory callback takes no arguments.
        fetchResponse("unexpected");
        return decode(response);
      };
    },
    annotated: (fetchResponse: FetchResponse) => async () =>
      (await fetchResponse()).status,
  },
});
const configuredPending = createDixous({ extensions: [configuredMethods] })({
  traceLabel: "test",
}).fetch("https://example.com", { trace: true });
const decoded = configuredPending.decoded(response => ({ status: response.status }));
type DecodedResult = Expect<Equal<typeof decoded, Promise<{ status: number }>>>;
const annotated = configuredPending.annotated();
type AnnotatedResult = Expect<Equal<typeof annotated, Promise<number>>>;
// @ts-expect-error Curried definitions preserve custom method arguments.
configuredPending.decoded("not a decoder");
// @ts-expect-error Contextual typing must not expose unregistered methods.
configuredPending.missing();

const noOptionsMethods = defineExtension()({
  methods: {
    status: fetchResponse => async () => (await fetchResponse()).status,
  },
});
const inferredStatus = createDixous({ extensions: [noOptionsMethods] })
  .fetch("https://example.com").status();
type InferredStatus = Expect<Equal<typeof inferredStatus, Promise<number>>>;

defineExtension({
  methods: {
    // @ts-expect-error Factories must return a response method, not a value.
    invalid: fetchResponse => 123,
  },
});
defineExtension()({
  methods: {
    // @ts-expect-error Response methods must return promises.
    invalid: fetchResponse => () => "synchronous",
  },
});

// @ts-expect-error Schema is required.
pending.json();
// @ts-expect-error JSON requires a Standard Schema, not an arbitrary parser.
pending.json({ parse: () => "invalid" });
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
// @ts-expect-error The default JSON method requires a schema.
empty.fetch("https://example.com").json();
// @ts-expect-error Unregistered options are unavailable.
empty.fetch("https://example.com", { retry: {} });

declare const transformedSchema: StandardSchemaV1<string, { count: number }>;
const defaults = empty.fetch("https://example.com");
const defaultJson = defaults.json(transformedSchema);
const extendedJson = pending.json(transformedSchema);
const defaultText = defaults.text();
const defaultBlob = defaults.blob();
const defaultBuffer = defaults.arrayBuffer();
const defaultResponse = defaults.response();
type DefaultJson = Expect<Equal<typeof defaultJson, Promise<{ count: number }>>>;
type ExtendedJson = Expect<Equal<typeof extendedJson, Promise<{ count: number }>>>;
type DefaultText = Expect<Equal<typeof defaultText, Promise<string>>>;
type DefaultBlob = Expect<Equal<typeof defaultBlob, Promise<Blob>>>;
type DefaultBuffer = Expect<Equal<typeof defaultBuffer, Promise<ArrayBuffer>>>;
type DefaultResponse = Expect<Equal<typeof defaultResponse, Promise<Response>>>;
// @ts-expect-error Default methods take no extra arguments.
defaults.text("prefix");
// @ts-expect-error The generic parameter is a schema, not the desired output.
defaults.json<{ count: number }>(transformedSchema);

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
