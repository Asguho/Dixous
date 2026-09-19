# Dixous

A small, fully typed HTTP client built on Fetch.

Dixous gives you a simple request API, runtime-validated responses, and an extension system that can add new behavior and new APIs without losing type inference.

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
  headers: {
    Authorization: "Bearer YOUR_API_TOKEN",
  },
});

const User = z.object({
  id: z.number(),
  name: z.string(),
});

const user = await api.request("users/1").json(User);

console.log(user.name); // string
```

The response is validated at runtime and inferred automatically from the schema.

Dixous works with any [Standard Schema](https://standardschema.dev/) validator.

## Why Dixous?

Dixous tries to stay small without becoming limiting.

- Built around native `Request` and `Response`
- Runtime validation with full TypeScript inference
- Immutable clients that can be progressively specialized
- Extensions can add middleware, configuration, client methods, and response methods
- Features such as retrying, caching, logging, and custom formats do not need to be built into the core
- Drop down to the native `Response` whenever you need to

## Extend the API itself

Extensions do more than run hooks. They can add completely new, fully typed APIs.

For example, [Schema XML](https://github.com/Asguho/schema-xml) can make XML feel like a native Dixous response format:

```ts
import { Dixous, defineExtension } from "dixous";
import { parseXml } from "schema-xml";
import { z } from "zod";

const xml = defineExtension({
  operation(operation) {
    return {
      xml: operation.terminal(
        async <Schema extends z.ZodType>(schema: Schema): Promise<z.output<Schema>> => {
          const response = await operation.successfulResponse();

          return parseXml(await response.text(), schema);
        },
      ),
    };
  },
});

const api = Dixous.create({
  extensions: [xml],
});

const Catalog = z.object({
  catalog: z.object({
    book: z.array(
      z.object({
        title: z.string(),
      }),
    ),
  }),
});

const catalog = await api.request("https://example.com/catalog.xml").xml(Catalog);

console.log(catalog.catalog.book);
// { title: string }[]
```

Dixous itself knows nothing about XML. The extension adds `.xml(schema)` to the client with the same type inference you would expect from a built-in API.

```sh
npm install schema-xml zod
```

## Handle failures your way

Use ordinary promise rejection:

```ts
const user = await api.request("users/1").json(User);
```

Or turn the same operation into an explicit result:

```ts
const result = await api.request("users/1").json(User).result();

if (result.ok) {
  console.log(result.value.name);
} else {
  console.error(result.error);
}
```

And when you want full control over HTTP semantics, use the native response:

```ts
const response = await api.request("users/1").response();

if (response.status === 404) {
  // Handle an expected 404.
}
```

## Typed extensions

Extensions can contribute options as well as behavior.

```ts
const query = defineExtension<{
  query?: Record<string, string>;
}>()({
  async middleware(context, dispatch) {
    const url = new URL(context.request.url);

    for (const [key, value] of Object.entries(context.options.query ?? {})) {
      url.searchParams.append(key, value);
    }

    context.request = new Request(url, context.request);

    return dispatch();
  },
});
```

Install it:

```ts
const api = Dixous.create({
  extensions: [query],
});
```

And the option becomes part of the client:

```ts
const books = await api
  .request("books", {
    query: {
      author: "Ursula K. Le Guin",
    },
  })
  .json(Books);
```

Remove the extension and `query` disappears from the type.

The same extension system can power retries, authentication, caching, logging, tracing, custom transports, custom response formats, and application-specific APIs.

See [Extensions](./docs/extensions.md) for the full extension model and advanced patterns.

## Development

```sh
npm ci
npm test
```

See [RELEASING.md](./RELEASING.md) for npm and JSR publishing.
