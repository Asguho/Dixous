# Dixous

A small TypeScript query client built on native `Request`, `Response`, and Fetch.
The core has no runtime dependencies. Extensions supply request middleware and
response methods; no response methods are installed by default.

## Usage

```ts
import { createDixous, defineExtension, type FetchResponse } from "dixous";

const responses = defineExtension({
  methods: {
    text: (fetchResponse: FetchResponse) => async () => (await fetchResponse()).text(),
    json: (fetchResponse: FetchResponse) => async <T>(schema: { parse(value: unknown): T }) => {
      const response = await fetchResponse();
      return schema.parse(await response.json());
    },
  },
});

const dixous = createDixous({ extensions: [responses] });
const api = dixous({
  baseUrl: "https://example.com/api/",
  headers: { accept: "application/json" },
});

const pending = api.fetch("users"); // Constructs a request; no middleware or I/O.
const text = await pending.text();  // Executes one operation.
const again = await pending.text(); // Executes a separate operation.
```

`createDixous({ extensions, fetch })` accepts an optional custom transport with
the native Fetch signature. The root `dixous.fetch(...)` uses an empty client
configuration. Calling `dixous(options)` creates a configured fetcher.

## Extension configuration and state

Use the curried `defineExtension<RequestExtra, ClientExtra>()` overload to
contribute typed options. Both option types default to `{}`. Options from all
registered extensions are combined in the resulting client.

```ts
import { createContextKey, defineExtension } from "dixous";

export const requestStarted = createContextKey<number>();

const authentication = defineExtension<
  { auth?: { skip: boolean } },
  { auth?: { token: string } }
>()({
  async request(context, next) {
    context.state.set(requestStarted, performance.now());
    if (!context.options.auth?.skip && context.client.auth) {
      context.request.headers.set(
        "authorization",
        `Bearer ${context.client.auth.token}`,
      );
    }
    return next();
  },
});
```

Each extension should own a configuration namespace. Request contributions may
not redefine `RequestInit` fields; client contributions may not redefine
`baseUrl` or `headers`. These reserved names are checked by the definition types.
Authors must coordinate option namespaces across extensions: the supplied type
interface combines contributions by intersection and carries no runtime option
schema for detecting conflicts. Duplicate response-method names are rejected
at composition.

`context.state` stores transient values under identity-based typed symbol keys.
All middleware in an operation shares it, including repeated downstream
traversals. A different operation receives a fresh state store.

## Execution contract

- `fetch()` immediately resolves URLs, merges headers, snapshots options, and
  constructs a canonical native request template. Native construction errors
  may throw synchronously. The template itself never reaches transport.
- String and URL inputs resolve with `new URL(input, baseUrl)` when a base URL
  is configured. Without one, native Request URL rules apply. Request inputs
  retain their URL and ignore the client base URL.
- Headers merge by name in order: client headers, input Request headers, request
  option headers. Middleware can then modify the execution request.
- Every response-method invocation instantiates its factory with a new
  `FetchResponse`. Execution starts only when that function is called. It
  memoizes the exact promise, including failures, and returns the same response
  on repeated calls within that operation.
- Execution creates a fresh request clone, context state, and middleware
  traversal. Middleware runs in registration order and unwinds in reverse.
  Middleware may replace `context.request` or return a response without calling
  `next()`.
- A middleware may call `next()` repeatedly after each preceding call settles.
  Each call re-enters the remaining middleware with the same operation context.
  Concurrent calls to that same `next()` reject. Core never retries on its own.
- Every terminal call passes a fresh clone of the current `context.request` to
  transport. Request changes and state can accumulate across repeated
  traversals; extensions own retry policy and any restoration they need.
- Middleware receives all HTTP statuses. After the complete stack resolves,
  `FetchResponse` throws `HttpError` for a non-OK final response. Its `request`
  is the operation's current canonical request, its `response` is the actual
  final response, and its `status` equals `response.status`.
- Response parsing and validation happen after middleware unwinds. Request
  middleware cannot catch response-method failures or include parsing time in
  its timing scope. Middleware and transport failures propagate unchanged.

## Snapshots and native Fetch semantics

Client configuration is copied and shallow-frozen when a fetcher is created;
request options are copied and shallow-frozen when `fetch()` is called. Headers
are copied and client URL objects are captured as strings. Arbitrary nested
extension values retain identity. Shallow freezing does not make methods such
as `Headers.set()` immutable: middleware must treat configuration as read-only
and make execution changes through `context.request`.

Composition captures the extension ordering, middleware functions, method
factories, and transport. Subsequent changes to caller-owned registrations do
not affect the instance. Pending response-method objects are frozen.

Abort signals retain native cancellation linkage. During execution,
`context.request.signal` is authoritative. To change a URL while preserving
request properties and cancellation, use `new Request(newUrl, context.request)`.

Bodies remain native streams. Core does not clone responses or introduce body
buffering. Middleware inspecting a body should explicitly clone the request or
response first. Request cloning can tee streams and affect buffering and
backpressure; pending-request reuse and retries remain subject to native body
replayability. Extensions are responsible for deciding when a retry is safe.

## Development

Requires an environment with native Fetch APIs. Development tests use Node's
built-in test runner and the locally installed TypeScript compiler.

```sh
npm ci
npm test
```

`npm test` builds the package, checks type-level API expectations, and runs the
runtime contract tests. `npm run build` emits ESM and declarations to `dist/`.
