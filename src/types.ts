declare const contextKeyType: unique symbol;

export type ContextKey<T> = symbol & {
  readonly [contextKeyType]: (value: T) => T;
};

export interface Context {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
}

export type RequestOptions<Extra extends object = {}> = RequestInit & Extra;

export interface BaseClientOptions {
  baseUrl?: string | URL;
  headers?: HeadersInit;
}

export type ClientOptions<Extra extends object = {}> = BaseClientOptions & Extra;

export interface RequestContext<
  RequestExtra extends object = {},
  ClientExtra extends object = {},
> {
  request: Request;
  readonly options: Readonly<RequestOptions<RequestExtra>>;
  readonly client: Readonly<ClientOptions<ClientExtra>>;
  readonly state: Context;
}

export type Next = () => Promise<Response>;

export type Middleware<
  RequestExtra extends object = {},
  ClientExtra extends object = {},
> = (
  context: RequestContext<RequestExtra, ClientExtra>,
  next: Next,
) => Promise<Response>;

export type FetchResponse = () => Promise<Response>;

export type ResponseMethod = (
  fetchResponse: FetchResponse,
) => (...args: never[]) => Promise<unknown>;

export type ResponseMethods = Record<string, ResponseMethod>;

type InstantiateMethods<Methods extends ResponseMethods> = {
  readonly [K in keyof Methods]: ReturnType<Methods[K]>;
};

declare const extensionType: unique symbol;

export interface ExtensionMeta {
  readonly [extensionType]: {
    request: object;
    client: object;
    methods: ResponseMethods;
  };
}

export interface Extension<
  RequestExtra extends object = {},
  ClientExtra extends object = {},
  Methods extends ResponseMethods = {},
> {
  readonly [extensionType]: {
    request: RequestExtra;
    client: ClientExtra;
    methods: Methods;
  };
  request?: Middleware<RequestExtra, ClientExtra>;
  methods?: Methods;
}

export type ExtensionDefinition<
  RequestExtra extends object,
  ClientExtra extends object,
  Methods extends ResponseMethods,
> = Pick<Extension<RequestExtra, ClientExtra, Methods>, "request"> & {
  // Contextually type factory parameters while preserving each method's signature.
  methods?: Methods & Record<string, (fetchResponse: FetchResponse) => unknown>;
};

export type NoRequestInitOverrides = {
  [K in keyof RequestInit]?: never;
};

export type NoClientOptionOverrides = {
  [K in keyof BaseClientOptions]?: never;
};

type UnionToIntersection<T> = [T] extends [never]
  ? {}
  : (T extends unknown ? (value: T) => void : never) extends (
        value: infer Result,
      ) => void
    ? Result
    : never;

export type ExtensionRequestOptions<
  Extensions extends readonly ExtensionMeta[],
> = UnionToIntersection<
  Extensions[number][typeof extensionType]["request"]
> extends infer Result extends object
  ? Result
  : never;

export type ExtensionClientOptions<
  Extensions extends readonly ExtensionMeta[],
> = UnionToIntersection<
  Extensions[number][typeof extensionType]["client"]
> extends infer Result extends object
  ? Result
  : never;

export type ExtensionMethods<Extensions extends readonly ExtensionMeta[]> =
  UnionToIntersection<
    Extensions[number][typeof extensionType]["methods"]
  > extends infer Result extends ResponseMethods
    ? Result
    : never;

export interface Fetcher<
  RequestExtra extends object,
  Methods extends ResponseMethods,
> {
  fetch(
    input: string | URL | Request,
    options?: RequestOptions<RequestExtra>,
  ): InstantiateMethods<Methods>;
}

export interface Dixous<
  RequestExtra extends object,
  ClientExtra extends object,
  Methods extends ResponseMethods,
> extends Fetcher<RequestExtra, Methods> {
  (options?: ClientOptions<ClientExtra>): Fetcher<RequestExtra, Methods>;
}
