import type { InferOutput, StandardSchemaV1 } from "./standard-schema.ts";

export type RequestInput = string | URL | Request;
export type RequestOptions<Options extends object = {}> = RequestInit & Options;

export interface RequestContext<Options extends object = {}> {
  /** Exact original input, even when middleware replaces request. */
  readonly input: RequestInput;
  /** Request used by the next execution step; middleware may replace it. */
  request: Request;
  /** Shallow readonly snapshot of effective client and request options. */
  readonly options: Readonly<RequestOptions<Options>>;
}

/**
 * Reruns the remaining chain. Sequential calls are allowed; concurrent calls
 * reject. Dixous does not clone or buffer bodies: callers must ensure replayability.
 */
export type Next = () => Promise<Response>;
export type RequestMiddleware<Options extends object = {}> = (
  context: RequestContext<Options>, next: Next,
) => Promise<Response>;

export interface OperationContext<Options extends object = {}> extends RequestContext<Options> {
  /** Memoized logical execution. The native response body remains one-shot. */
  response(): Promise<Response>;
}

/** Default body readers require response.ok; schema/platform errors are preserved. */
export interface DefaultOperationApi {
  json<Schema extends StandardSchemaV1>(schema: Schema): Promise<InferOutput<Schema>>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type RequestOperation<OperationApi extends object = DefaultOperationApi> =
  OperationApi & {
    /** Returns the native response without applying a status policy. */
    readonly response: () => Promise<Response>;
    readonly then?: never;
  };

declare const extensionType: unique symbol;

export interface ExtensionDefinition<Options extends object, OperationApi extends object> {
  /** Runs in extension order with onion semantics. */
  readonly request?: RequestMiddleware<Options>;
  /** Created once per operation. Later contributions replace earlier methods. */
  readonly operation?: (
    operation: OperationContext<Options>,
  ) => OperationApiContribution<OperationApi>;
}

export type Extension<Options extends object = {}, OperationApi extends object = {}> =
  ExtensionDefinition<Options, OperationApi> & {
    readonly [extensionType]?: {
      readonly options: Options;
      readonly operationApi: OperationApi;
    };
  };

export interface CoreOptions {
  /** Resolves string and URL inputs using native WHATWG URL semantics. */
  readonly baseUrl?: string | URL;
  /** Defaults merged by header name in derived clients and requests. */
  readonly headers?: HeadersInit;
  /** Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export type CreateOptions<CurrentOptions extends object, Extensions extends readonly AnyExtension[]> =
  { readonly extensions?: Extensions } &
  CoreOptions & {
    // Materialize the fold so inline extension arrays retain tuple inference.
    [Key in keyof ApplyExtensionOptions<CurrentOptions, Extensions>]:
      ApplyExtensionOptions<CurrentOptions, Extensions>[Key];
  };

export interface Dixous<Options extends object = {}, OperationApi extends object = DefaultOperationApi> {
  /** Constructs a Request immediately; execution waits until response() is called. */
  request(input: RequestInput, options?: RequestOptions<Options>): RequestOperation<OperationApi>;
  /** Inherits configuration, merges headers, appends extensions; never mutates the parent. */
  create<const Extensions extends readonly AnyExtension[] = []>(
    options?: CreateOptions<Options, Extensions>,
  ): Dixous<ApplyExtensionOptions<Options, Extensions>, ApplyExtensionApi<OperationApi, Extensions>>;
  readonly then?: never;
}

export type AnyExtension = Extension<any, any>;

// AnyExtension erases the API for composition; concrete APIs still reserve response.
type OperationApiContribution<Api extends object> =
  unknown extends Api ? Api : "response" extends keyof Api ? never : Api;
type ExtensionOptions<E extends AnyExtension> = E extends Extension<infer Options, any> ? Options : {};
type ExtensionOperationApi<E extends AnyExtension> = E extends Extension<any, infer Api> ? Api : {};
type Merge<Left extends object, Right extends object> = Omit<Left, keyof Right> & Right;

export type ApplyExtensionOptions<Current extends object, Extensions extends readonly AnyExtension[]> =
  Extensions extends readonly [infer Head extends AnyExtension, ...infer Tail extends readonly AnyExtension[]]
    ? ApplyExtensionOptions<Merge<Current, ExtensionOptions<Head>>, Tail>
    : Current;

export type ApplyExtensionApi<Current extends object, Extensions extends readonly AnyExtension[]> =
  Extensions extends readonly [infer Head extends AnyExtension, ...infer Tail extends readonly AnyExtension[]]
    ? ApplyExtensionApi<Merge<Current, ExtensionOperationApi<Head>>, Tail>
    : Current;
