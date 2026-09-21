import { ConcurrentNextError, UnexpectedResponseError } from "./errors.ts";
import { defaultOperationApi } from "./response-methods.ts";
import type {
  AnyExtension, ApplyExtensionApi, ApplyExtensionOptions, CoreOptions, CreateOptions,
  DefaultOperationApi, Dixous as DixousClient, Extension,
  ExtensionDefinition, OperationContext, RequestContext, RequestInput,
  MatchedOperation, RequestMiddleware, RequestOptions, ReservedOperationKey,
} from "./types.ts";

export { ConcurrentNextError, ResponseValidationError, UnexpectedResponseError } from "./errors.ts";
export type { InferOutput, StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from "./standard-schema.ts";
export type {
  AnyExtension, CoreOptions, CreateOptions, DefaultOperationApi, Extension,
  ExtensionDefinition, Match, MatchedOperation, MatchResult, Next, OperationContext,
  RequestContext, RequestInput, RequestMiddleware, RequestOperation, RequestOptions,
  ReservedOperationKey, StatusHandlers,
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

const reservedOperationKeys = ["response", "then"] as const satisfies readonly ReservedOperationKey[];

function createOperation(
  context: RequestContext,
  execute: () => Promise<Response>,
  extensions: readonly AnyExtension[],
) {
  const build = (response: () => Promise<Response>): MatchedOperation<{}> => {
    const scoped: OperationContext = Object.create(context, {
      response: { value: response, enumerable: true },
      execute: { value: execute, enumerable: true },
      api: { value: (matched: Response) => build(async () => matched), enumerable: true },
    });
    const operation = Object.assign(Object.create(null), defaultOperationApi(scoped));
    for (const extension of extensions) {
      const contribution = extension.operation?.(scoped);
      if (contribution !== undefined) {
        for (const key of reservedOperationKeys) {
          if (key in contribution) throw new TypeError(`Extension operation cannot replace ${key}`);
        }
        Object.assign(operation, contribution);
      }
    }
    return Object.defineProperties(operation, {
      response: { value: execute, enumerable: true },
      then: { value: undefined },
    });
  };
  return build(async () => {
    const response = await execute();
    if (!response.ok) throw new UnexpectedResponseError(context.request, response);
    return response;
  });
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
      const execute = () => {
        // Store the promise before middleware can synchronously re-enter execute().
        execution ??= Promise.resolve().then(() => runMiddleware(middleware, context, transport));
        return execution;
      };
      const context: RequestContext = { input, request, options };
      Object.defineProperties(context, { input: { writable: false }, options: { writable: false } });
      return createOperation(context, execute, extensions);
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
