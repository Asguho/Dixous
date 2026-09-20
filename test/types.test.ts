import {
  Dixous, defineExtension, type DefaultOperationApi, type OperationContext,
  type StandardSchemaV1, type StandardSchemaIssue, type StandardSchemaResult,
  type InferOutput, type RequestOperation, type Extension,
} from "../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const retry = defineExtension<{ attempts?: number }>()({
  async request(context, next) {
    const attempts: number | undefined = context.options.attempts;
    // @ts-expect-error Options are readonly.
    context.options.attempts = 2;
    // @ts-expect-error Original input is readonly.
    context.input = "other";
    context.request = new Request(context.request);
    return next();
  },
  operation(operation) {
    type Context = Expect<Equal<typeof operation, OperationContext<{ attempts?: number }>>>;
    return {
      async decoded<T>(decode: (response: Response) => T): Promise<T> {
        return decode(await operation.response());
      },
    };
  },
});
const api = Dixous.create({ extensions: [retry], attempts: 3, baseUrl: "https://example.com" });
const pending = api.request("/", { attempts: 2 });
const decoded = pending.decoded(response => ({ status: response.status }));
type Decoded = Expect<Equal<typeof decoded, Promise<{ status: number }>>>;
// @ts-expect-error Generic methods preserve their argument types.
pending.decoded("not a decoder");
// @ts-expect-error Unknown options are rejected.
api.request("/", { unknown: true });
// @ts-expect-error Options preserve contributed types.
api.create({ attempts: "three" });
// @ts-expect-error Core response is readonly.
pending.response = async () => new Response();
// @ts-expect-error Operations cannot be made thenable.
pending.then = () => {};
// @ts-expect-error Clients cannot be made thenable.
api.then = () => {};

const replacement = defineExtension<{ attempts?: string }>()({
  operation: operation => ({ text: async (prefix: string) => prefix.length }),
});
const derived = api.create({ extensions: [replacement], attempts: "three" });
const overridden = derived.request("/", { attempts: "two" });
const number = overridden.text("prefix");
type Overridden = Expect<Equal<typeof number, Promise<number>>>;
overridden.decoded(response => response.status);
// @ts-expect-error Last contribution replaces the original signature.
overridden.text();
// @ts-expect-error Last option contribution replaces the original type.
derived.request("/", { attempts: 2 });
const original = pending.text();
type Original = Expect<Equal<typeof original, Promise<string>>>;
const inline = Dixous.create({ extensions: [retry, replacement], attempts: "two" });
inline.request("/", { attempts: "one" }).text("prefix");
const final = defineExtension({ operation: () => ({ text: () => true }) });
const finalResult = derived.create({ extensions: [final] }).request("/").text();
type Final = Expect<Equal<typeof finalResult, true>>;

// @ts-expect-error response is reserved, including on inferred contributions.
defineExtension({ operation: () => ({ response: async () => new Response() }) });
// @ts-expect-error response is also reserved on curried definitions.
defineExtension<{ label?: string }>()({ operation: () => ({ response: () => 1 }) });

const base: Dixous = Dixous.create();
const defaults: RequestOperation<DefaultOperationApi> = base.request("https://example.com");
declare const schema: StandardSchemaV1<string, { count: number }>;
const json = defaults.json(schema);
type Json = Expect<Equal<typeof json, Promise<{ count: number }>>>;
type Output = Expect<Equal<InferOutput<typeof schema>, { count: number }>>;
const text = defaults.text();
const blob = defaults.blob();
const buffer = defaults.arrayBuffer();
const response = defaults.response();
type Text = Expect<Equal<typeof text, Promise<string>>>;
type BlobResult = Expect<Equal<typeof blob, Promise<Blob>>>;
type BufferResult = Expect<Equal<typeof buffer, Promise<ArrayBuffer>>>;
type ResponseResult = Expect<Equal<typeof response, Promise<Response>>>;
// @ts-expect-error JSON requires a schema.
defaults.json();
// @ts-expect-error Arbitrary parsers are not Standard Schema validators.
defaults.json({ parse: () => 1 });
// @ts-expect-error No unregistered methods.
defaults.bytes();
// @ts-expect-error No legacy fetch API.
base.fetch("/");
// @ts-expect-error Unregistered options are unavailable.
base.request("/", { attempts: 2 });

const required = defineExtension<{ feature: boolean }>()({});
Dixous.create({ extensions: [required], feature: true }).request("/", { feature: false });
// @ts-expect-error Supplied options must include required fields.
Dixous.create({ extensions: [required] });
const declared: Extension<{ label?: string }, { status(): Promise<number> }> = {
  operation: operation => ({ status: async () => (await operation.response()).status }),
};
Dixous.create({ extensions: [declared], label: "test" }).request("/").status();
const issue: StandardSchemaIssue = { message: "bad", path: [Symbol(), { key: 1 }] };
const result: StandardSchemaResult<number> = { issues: [issue] };

// A Ky-style replacement removes the schema overload and retains its generic.
const uncheckedJson = defineExtension({
  operation: operation => ({
    async json<T>(): Promise<T> { return (await operation.response()).json() as Promise<T>; },
  }),
});
const kyStyle = api.create({ extensions: [uncheckedJson] }).create();
const unchecked = kyStyle.request('/').json<{ name: string }>();
type Unchecked = Expect<Equal<typeof unchecked, Promise<{ name: string }>>>;
// @ts-expect-error The previous schema overload has been replaced.
kyStyle.request('/').json(schema);
// @ts-expect-error Default json has no unchecked output generic.
defaults.json<{ name: string }>();
const retainedText = kyStyle.request('/').text();
type RetainedText = Expect<Equal<typeof retainedText, Promise<string>>>;
const retainedDecoded = kyStyle.request('/').decoded(response => response.status);
type RetainedDecoded = Expect<Equal<typeof retainedDecoded, Promise<number>>>;

const tracing = defineExtension<{ trace?: string; config?: { enabled: boolean } }>()({
  async request(context, next) {
    const trace: string | undefined = context.options.trace;
    const config: { enabled: boolean } | undefined = context.options.config;
    return next();
  },
  operation: context => ({ trace: () => context.options.trace }),
});
const combined = Dixous.create({ extensions: [retry, tracing], attempts: 2,
  trace: 'shared', config: { enabled: true },
});
const specialized = combined.create({ baseUrl: 'https://special.example/',
  headers: { Authorization: 'special' }, trace: 'special', extensions: [uncheckedJson],
}).create();
const specializedOperation = specialized.request('/', { attempts: 1, trace: 'request' });
type Trace = Expect<Equal<ReturnType<typeof specializedOperation.trace>, string | undefined>>;
const specializedDecoded = specializedOperation.decoded(response => response.ok);
type SpecializedDecoded = Expect<Equal<typeof specializedDecoded, Promise<boolean>>>;
const specializedJson = specializedOperation.json<number>();
type SpecializedJson = Expect<Equal<typeof specializedJson, Promise<number>>>;
// @ts-expect-error Installing an unrelated extension does not introduce these options.
api.request('/', { trace: 'missing extension' });
// @ts-expect-error Client options require the extension too.
Dixous.create({ trace: 'missing extension' });
// @ts-expect-error Added methods are unavailable without their extension.
base.request('/').trace();

const replaceDecoded = defineExtension({ operation: () => ({ decoded: (value: string) => value.length }) });
const replacedDecoded = specialized.create({ extensions: [replaceDecoded] }).request('/');
const decodedLength = replacedDecoded.decoded('hello');
type DecodedLength = Expect<Equal<typeof decodedLength, number>>;
// @ts-expect-error The inherited generic signature is gone.
replacedDecoded.decoded(response => response.status);
// @ts-expect-error Replaced generic methods do not retain type parameters.
replacedDecoded.decoded<number>('hello');

const allDefaultsReplaced = defineExtension({ operation: () => ({
  json: () => 1, text: () => false, blob: () => 'blob', arrayBuffer: () => null,
  promiseLike: (): PromiseLike<number> => Promise.resolve(1),
}) });
const replacedDefaults = Dixous.create({ extensions: [allDefaultsReplaced] }).request('/');
type RawResponseSurvives = Expect<Equal<ReturnType<typeof replacedDefaults.response>, Promise<Response>>>;
type PromiseLikeResult = Expect<Equal<ReturnType<typeof replacedDefaults.promiseLike>, PromiseLike<number>>>;
type ClientThen = Expect<Equal<typeof specialized.then, undefined>>;
type OperationThen = Expect<Equal<typeof specializedOperation.then, undefined>>;

const invalidDeclared: Extension<{}, { response(): Promise<Response> }> = {
  // @ts-expect-error Reserved response cannot be supplied using an explicit extension type.
  operation: () => ({ response: async () => new Response() }),
};
// @ts-expect-error Reserved response cannot bypass defineExtension through inline installation.
Dixous.create({ extensions: [{ operation: () => ({ response: async () => new Response() }) }] });
// @ts-expect-error Derived clients enforce the same reservation for inline extensions.
api.create({ extensions: [{ operation: () => ({ response: () => 1 }) }] });
const invalidInline = { operation: () => ({ response: async () => new Response() }) };
// @ts-expect-error Naming an inline extension does not bypass the reservation.
Dixous.create({ extensions: [invalidInline] });
