import { ConcurrentNextError } from "./errors.ts";
import { defaultOperationApi } from "./response-methods.ts";
import type {
  AnyExtension, ApplyExtensionApi, ApplyExtensionOptions, CoreOptions, CreateOptions,
  DefaultOperationApi, Dixous as DixousClient, Extension,
  ExtensionDefinition, OperationContext, RequestContext, RequestInput,
  RequestMiddleware, RequestOptions,
} from "./types.ts";

export { ConcurrentNextError, ResponseValidationError, UnexpectedResponseError } from "./errors.ts";
export type { InferOutput, StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from "./standard-schema.ts";
export type {
  AnyExtension, CoreOptions, CreateOptions, DefaultOperationApi, Extension,
  ExtensionDefinition, Next, OperationContext, RequestContext, RequestInput,
  RequestMiddleware, RequestOperation, RequestOptions,
} from "./types.ts";

export function defineExtension<const OperationApi extends object = {}>(
  definition: ExtensionDefinition<{}, OperationApi>,
): Extension<{}, OperationApi>;
export function defineExtension<Options extends object>(): <const OperationApi extends object = {}>(
  definition: ExtensionDefinition<Options, OperationApi>,
) => Extension<Options, OperationApi>;
export function defineExtension(definition?: object): unknown {
  return definition === undefined ? (entry: object) => entry : definition;
}

function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (source !== undefined) new Headers(source).forEach((value, name) => headers.set(name, value));
  }
  return headers;
}

function runMiddleware(
  middleware: readonly RequestMiddleware[],
  context: RequestContext,
  transport: typeof globalThis.fetch,
): Promise<Response> {
  async function dispatch(index: number): Promise<Response> {
    const current = middleware[index];
    if (current === undefined) return transport(context.request);
    let running = false;
    return current(context, async () => {
      if (running) throw new ConcurrentNextError();
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

type Configuration = CoreOptions & RequestOptions & { readonly extensions?: readonly AnyExtension[] };

function createOperation(context: OperationContext, extensions: readonly AnyExtension[]) {
  const { response } = context;
  const operation = Object.assign(Object.create(null), defaultOperationApi(context));
  for (const extension of extensions) {
    const contribution = extension.operation?.(context);
    if (contribution !== undefined) {
      if ("response" in contribution) throw new TypeError("Extension operation cannot replace response");
      Object.assign(operation, contribution);
    }
  }
  Object.defineProperties(operation, {
    response: { value: response, enumerable: true },
    then: { value: undefined },
  });
  return operation;
}

function createClient(parent: Configuration = {}, supplied: Configuration = {}): DixousClient {
  const { extensions: inherited = [], ...defaults } = parent;
  const { extensions: appended = [], ...overrides } = supplied;
  const configuration = Object.freeze({
    ...defaults,
    ...overrides,
    ...(overrides.baseUrl !== undefined ? { baseUrl: overrides.baseUrl.toString() } : {}),
    headers: mergeHeaders(defaults.headers, overrides.headers),
    // Capture contributions so later mutations cannot alter an immutable client.
    extensions: Object.freeze([...inherited, ...appended].map(entry => Object.freeze({ ...entry }))),
  });
  const { extensions, ...clientOptions } = configuration;
  const middleware = extensions.flatMap(entry => entry.request ? [entry.request] : []);
  const transport = configuration.fetch ?? globalThis.fetch;

  return Object.freeze({
    create(options?: Configuration) { return createClient(configuration, options); },
    request(input: RequestInput, suppliedOptions: RequestOptions = {}) {
      const options = Object.freeze({
        ...clientOptions,
        ...suppliedOptions,
        headers: mergeHeaders(
          configuration.headers,
          input instanceof Request ? input.headers : undefined,
          suppliedOptions.headers,
        ),
      });
      const source = !(input instanceof Request) && configuration.baseUrl !== undefined
        ? new URL(input.toString(), configuration.baseUrl)
        : input;
      const request = new Request(source, options);
      let execution: Promise<Response> | undefined;
      const response = () => {
        // Store the promise before middleware can synchronously re-enter response().
        execution ??= Promise.resolve().then(() => runMiddleware(middleware, context, transport));
        return execution;
      };
      const context: OperationContext = { input, request, options, response };
      Object.defineProperties(context, {
        input: { writable: false }, options: { writable: false }, response: { writable: false },
      });
      return createOperation(context, extensions);
    },
  }) as DixousClient;
}

export interface Dixous<Options extends object = {}, OperationApi extends object = DefaultOperationApi>
  extends DixousClient<Options, OperationApi> {}

export const Dixous: {
  create<const Extensions extends readonly AnyExtension[] = []>(
    options?: CreateOptions<{}, Extensions>,
  ): Dixous<ApplyExtensionOptions<{}, Extensions>, ApplyExtensionApi<DefaultOperationApi, Extensions>>;
} = Object.freeze({
  create: createClient.bind(undefined, {}) as DixousClient["create"],
});
