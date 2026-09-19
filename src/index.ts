import { defaultResponseMethods, type DefaultResponseMethods } from "./response-methods.ts";
import type {
  ClientOptions,
  Context,
  ContextKey,
  Dixous,
  Extension,
  ExtensionClientOptions,
  ExtensionDefinition,
  ExtensionMeta,
  ExtensionMethods,
  ExtensionRequestOptions,
  Fetcher,
  FetchResponse,
  Middleware,
  NoClientOptionOverrides,
  NoRequestInitOverrides,
  RequestContext,
  RequestOptions,
  ResponseMethods,
} from "./types.ts";

export { SchemaValidationError } from "./response-methods.ts";
export type { DefaultResponseMethods, InferOutput } from "./response-methods.ts";

export type {
  BaseClientOptions,
  ClientOptions,
  Context,
  ContextKey,
  Dixous,
  Extension,
  Fetcher,
  FetchResponse,
  Middleware,
  Next,
  RequestContext,
  RequestOptions,
} from "./types.ts";

export function createContextKey<T>(): ContextKey<T> {
  return Symbol() as ContextKey<T>;
}

function createContext(): Context {
  const values = new Map<symbol, unknown>();
  return {
    get<T>(key: ContextKey<T>) {
      return values.get(key) as T | undefined;
    },
    set<T>(key: ContextKey<T>, value: T) {
      values.set(key, value);
    },
  };
}

export function defineExtension<const Methods extends ResponseMethods = {}>(
  extension: ExtensionDefinition<{}, {}, Methods>,
): Extension<{}, {}, Methods>;
export function defineExtension<
  RequestExtra extends object & NoRequestInitOverrides = {},
  ClientExtra extends object & NoClientOptionOverrides = {},
>(): <const Methods extends ResponseMethods = {}>(
  extension: ExtensionDefinition<RequestExtra, ClientExtra, Methods>,
) => Extension<RequestExtra, ClientExtra, Methods>;
export function defineExtension(extension?: object): unknown {
  // Extension metadata is a type-only brand; composition uses the captured values.
  return extension === undefined ? (definition: object) => definition : extension;
}

export class HttpError extends Error {
  readonly request: Request;
  readonly response: Response;
  readonly status: number;

  constructor(request: Request, response: Response) {
    super(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "HttpError";
    this.request = request;
    this.response = response;
    this.status = response.status;
  }
}

function snapshotClient(options: ClientOptions = {}): Readonly<ClientOptions> {
  const client = { ...options };
  if (client.baseUrl !== undefined) client.baseUrl = client.baseUrl.toString();
  if (client.headers !== undefined) client.headers = new Headers(client.headers);
  return Object.freeze(client);
}

function snapshotOptions(options: RequestOptions = {}): Readonly<RequestOptions> {
  const snapshot = { ...options };
  if (snapshot.headers !== undefined) snapshot.headers = new Headers(snapshot.headers);
  return Object.freeze(snapshot);
}

function createTemplate(
  input: string | URL | Request,
  options: Readonly<RequestOptions>,
  client: Readonly<ClientOptions>,
): Request {
  const headers = new Headers(client.headers);
  if (input instanceof Request) {
    input.headers.forEach((value, name) => headers.set(name, value));
  }
  if (options.headers !== undefined) {
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  }
  const source = !(input instanceof Request) && client.baseUrl !== undefined
    ? new URL(input.toString(), client.baseUrl)
    : input;
  return new Request(source, { ...options, headers });
}

function runMiddleware(
  middleware: readonly Middleware[],
  context: RequestContext,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  async function dispatch(index: number): Promise<Response> {
    const current = middleware[index];
    if (current === undefined) return fetchImpl(context.request.clone());

    // Each middleware invocation owns its guard. Sequential retries re-enter
    // the downstream chain with the same context and new downstream guards.
    let running = false;
    return current(context, async () => {
      if (running) throw new Error("Overlapping next() calls are not allowed");
      running = true;
      try {
        return await dispatch(index + 1);
      } finally {
        running = false;
      }
    });
  }
  return dispatch(0);
}

function createFetchResponse(
  template: Request,
  options: Readonly<RequestOptions>,
  client: Readonly<ClientOptions>,
  middleware: readonly Middleware[],
  fetchImpl: typeof globalThis.fetch,
): FetchResponse {
  let execution: Promise<Response> | undefined;
  return () => {
    // Defer execution until after storing the promise, including when a
    // synchronous middleware re-enters its operation's FetchResponse.
    execution ??= Promise.resolve().then(async () => {
      const context: RequestContext = {
        request: template.clone(),
        options,
        client,
        state: createContext(),
      };
      const response = await runMiddleware(middleware, context, fetchImpl);
      if (!response.ok) throw new HttpError(context.request, response);
      return response;
    });
    return execution;
  };
}

export function createDixous<
  const Extensions extends readonly ExtensionMeta[] = [],
>(options?: {
  extensions?: Extensions;
  fetch?: typeof globalThis.fetch;
}): Dixous<
  ExtensionRequestOptions<Extensions>,
  ExtensionClientOptions<Extensions>,
  DefaultResponseMethods & ExtensionMethods<Extensions>
> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const middleware: Middleware[] = [];
  const methods = new Map<string, ResponseMethods[string]>(Object.entries(defaultResponseMethods));

  for (const entry of options?.extensions ?? []) {
    // Contributions are erased only inside the kernel; the public signature
    // intersects their exact types when constructing the resulting client.
    const extension = entry as Extension<{}, {}, ResponseMethods>;
    if (extension.request !== undefined) middleware.push(extension.request);
    for (const [name, factory] of Object.entries(extension.methods ?? {})) {
      if (methods.has(name)) throw new Error(`Duplicate response method: ${name}`);
      methods.set(name, factory);
    }
  }

  function configured(clientOptions?: ClientOptions): Fetcher<{}, ResponseMethods> {
    const client = snapshotClient(clientOptions);
    return {
      fetch(input, requestOptions) {
        const snapshot = snapshotOptions(requestOptions);
        const template = createTemplate(input, snapshot, client);
        const pending: Record<string, (...args: never[]) => Promise<unknown>> =
          Object.create(null);
        for (const [name, factory] of methods) {
          pending[name] = (...args) => {
            const fetchResponse = createFetchResponse(
              template, snapshot, client, middleware, fetchImpl,
            );
            // Factories and method work are lazy too, and run once per call.
            return factory(fetchResponse)(...args);
          };
        }
        return Object.freeze(pending);
      },
    };
  }

  return Object.assign(configured, { fetch: configured().fetch }) as Dixous<
    ExtensionRequestOptions<Extensions>,
    ExtensionClientOptions<Extensions>,
    DefaultResponseMethods & ExtensionMethods<Extensions>
  >;
}
