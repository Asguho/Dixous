# Dixous

A small, typed HTTP client built on native Fetch, with lazy operations,
Standard Schema validation, and composable extensions.

## Installation

```sh
npm install dixous
```

## Quick start

```ts
import { Dixous } from "dixous";
import { z } from "zod";

const api = Dixous.create({
  baseUrl: "https://api.example.com/",
  headers: { Authorization: "Bearer YOUR_API_TOKEN" },
});

const User = z.object({ id: z.number(), name: z.string() });
const user = await api.request("users/1").json(User);
console.log(user.name); // string
```

`json(schema)` supports Standard Schema v1 validators and infers the schema's
output, including transformations. The other default helpers are `text()`,
`blob()`, and `arrayBuffer()`.

## One operation, one execution

`request()` constructs a native `Request` immediately. Network execution starts
when a helper calls `response()`. All helpers on that operation share one
memoized execution, including failures:

```ts
const operation = api.request("users/1");
const response = await operation.response();
const sameResponse = await operation.response(); // same Response; no new request
```

Clients and operations are not thenable. Await an operation's helper to execute
it. Call `request()` again for an independent operation.

Bodies retain native one-shot semantics: Dixous does not clone or buffer requests
or responses. Reading a response body twice fails as it would with native Fetch.

`response()` returns any HTTP status without imposing a status policy. The four
default body helpers require `response.ok` and throw `UnexpectedResponseError`
otherwise. This error includes `request` and `response`.

`json(schema)` throws `ResponseValidationError` when validation returns issues.
It includes `request`, `response`, and the original `issues`. Platform errors and
errors thrown or rejected by validators are preserved.

## Derive clients

```ts
const authenticated = api.create({
  headers: { Authorization: "Bearer NEW_TOKEN" },
});

await authenticated.request("users/1", {
  headers: { "X-Trace": "example" },
}).json(User);
```

Derived clients inherit configuration and extensions without mutating the parent.
Supplied values replace inherited values, headers merge by name, and extensions
append in order. At request construction, headers merge in this order: client
defaults, input `Request` headers, then request options.

String and URL inputs resolve against `baseUrl` using native WHATWG URL semantics.
A `Request` input keeps its own URL. Supply `fetch` to replace the transport.

## Typed request middleware

```ts
import { Dixous, defineExtension } from "dixous";

const query = defineExtension<{
  query?: Record<string, string>;
}>()({
  async request(context, next) {
    const url = new URL(context.request.url);
    for (const [key, value] of Object.entries(context.options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    context.request = new Request(url, context.request);
    return next();
  },
});

const api = Dixous.create({
  baseUrl: "https://api.example.com/",
  extensions: [query],
  query: { language: "en" },
});

const response = await api.request("books", {
  query: { author: "Ursula K. Le Guin" },
}).response();
```

Extension options are available directly on both client and request options.
`context.options` is a shallow readonly snapshot of their effective values.
`context.input` always refers to the original input; replacing `context.request`
does not change either `input` or `options`.

Middleware runs in extension order with onion semantics: A before, B before,
transport, B after, A after. It can return a response without calling `next()`.
Each sequential call to `next()` reruns all remaining middleware and can perform
another transport attempt. Concurrent calls to the same continuation reject with
`ConcurrentNextError`. Retry middleware must provide a replayable request itself.

## Extend operation methods

```ts
const status = defineExtension({
  operation(operation) {
    return {
      async status() {
        return (await operation.response()).status;
      },
    };
  },
});

const withStatus = api.create({ extensions: [status] });
const code = await withStatus.request("health").status(); // number
```

Each operation factory runs once when `request()` is called. Its context includes
`input`, the replaceable `request`, `options`, and the memoized `response()`.
Custom helpers decide their own status policy.

Later extensions replace earlier operation methods, including default body
helpers. Type composition follows the same order for methods and options.
`response` is reserved and cannot be replaced. Operations always remain
non-thenable. For extension lists stored in a variable, use `as const` to preserve
ordered tuple inference.

## Development

```sh
npm ci
npm test
npm run test:package
```

See [RELEASING.md](./RELEASING.md) for npm and JSR publishing.
