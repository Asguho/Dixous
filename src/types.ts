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
  /** Operation methods observe the request; only middleware replaces it. */
  readonly request: Request;
  /** The response this operation reads: rejects non-ok unless built by api(). The body is one-shot. */
  response(): Promise<Response>;
  /** Memoized raw execution without a status policy. */
  execute(): Promise<Response>;
  /** Rebuilds every contribution over a specific response. Contributions are pure factories. */
  api(response: Response): MatchedOperation<{}>;
}

/** Default body readers require response.ok; schema/platform errors are preserved. */
export interface DefaultOperationApi {
  json<Schema extends StandardSchemaV1>(schema: Schema): Promise<InferOutput<Schema>>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Branches on the exact status; unmatched statuses reject with UnexpectedResponseError. */
  match: Match<{}>;
}

export type ReservedOperationKey = "response" | "then";

export type StatusHandlers<OperationApi extends object> = {
  readonly [status: number]: (operation: MatchedOperation<OperationApi>) => unknown;
};
export type MatchResult<Handlers extends StatusHandlers<any>> =
  Awaited<ReturnType<Handlers[keyof Handlers & number]>>;
export type Match<OperationApi extends object> =
  <Handlers extends StatusHandlers<OperationApi>>(handlers: Handlers) => Promise<MatchResult<Handlers>>;

interface CoreOperation {
  /** Returns the native response without applying a status policy. */
  readonly response: () => Promise<Response>;
  readonly then?: never;
}

export type MatchedOperation<OperationApi extends object = DefaultOperationApi> =
  Omit<OperationApi, "match"> & CoreOperation;

// The default match is declared over {} and bound here, where the final API is known.
export type RequestOperation<OperationApi extends object = DefaultOperationApi> = {
  [Key in keyof OperationApi]: Key extends "match"
    ? OperationApi[Key] extends Match<{}> ? Match<OperationApi> : OperationApi[Key]
    : OperationApi[Key];
} & CoreOperation;

declare const extensionType: unique symbol;

export interface ExtensionDefinition<Options extends object, OperationApi extends object> {
  /** Runs in extension order with onion semantics. */
  readonly request?: RequestMiddleware<Options>;
  /**
   * Pure API factory: may run more than once for one logical request, once per
   * api() call. Later contributions replace earlier methods.
   */
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
  { readonly extensions?: Extensions & NoInfer<{
    // Validate inline contributions too; erased APIs retain runtime validation.
    [Index in keyof Extensions]:
      [OperationApiContribution<ReturnType<NonNullable<Extensions[Index]["operation"]>>>] extends [never]
        ? never : Extensions[Index];
  }> } &
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

// AnyExtension erases the API for composition; concrete APIs still reserve core keys.
type OperationApiContribution<Api extends object> =
  unknown extends Api ? Api : [Extract<keyof Api, ReservedOperationKey>] extends [never] ? Api : never;
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
