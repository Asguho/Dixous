# Dixous

A minimal, fully typed, extendable fetch client.

Start with a simple request, then add validation, middleware, and custom response handlers as you need them.

## Installation

```sh
npm install dixous
```

## Usage

```ts
import { Dixous } from "dixous";
import { z } from "zod";

export const dixous = Dixous.create({
  baseUrl: "https://api.example.com/",
  headers: {
    Authorization: "Bearer YOUR_API_TOKEN",
  },
});

const image = await dixous
  .request("https://example.com/image.png")
  .blob();

const User = z.object({
  id: z.number(),
  name: z.string(),
});

const user = await dixous
  .request("users/1")
  .json(User);

console.log(user.name); // string, validated at runtime
```

Requests run when you call `.json(schema)`, `.text()`, `.blob()`, `.arrayBuffer()`, `.response()`, or another terminal added by an extension.

JSON accepts any Standard Schema v1 validator.

## Fully extensible

Define your client once. Add response methods, middleware, and typed options with `defineExtension`.

```ts
// lib/dixous.ts

import {
  Dixous,
  defineExtension,
} from "dixous";
import { parseXml } from "schema-xml";
import { z } from "zod";

// Parse and validate XML with Schema XML.
const xml = defineExtension({
  operation(operation) {
    return {
      xml: operation.terminal(
        async <S extends z.ZodType>(
          schema: S,
        ): Promise<z.output<S>> => {
          const response =
            await operation.successfulResponse();

          return parseXml(
            await response.text(),
            schema,
          );
        },
      ),
    };
  },
});

// Retry GET requests up to three times in total on a 503 response.
const retry = defineExtension<{
  retryAttempts?: number;
}>()({
  async middleware(context, dispatch) {
    const attempts =
      context.options.retryAttempts ?? 3;

    for (let attempt = 1; ; attempt++) {
      context.request.signal.throwIfAborted();

      const response = await dispatch();

      if (
        context.request.method !== "GET" ||
        response.status !== 503 ||
        attempt >= attempts
      ) {
        return response;
      }

      await response.body?.cancel();
    }
  },
});

// Add a typed query option.
const query = defineExtension<{
  query?: Record<string, string>;
}>()({
  async middleware(context, dispatch) {
    const url = new URL(context.request.url);

    for (
      const [key, value]
      of Object.entries(
        context.options.query ?? {},
      )
    ) {
      url.searchParams.append(key, value);
    }

    context.request =
      new Request(url, context.request);

    return dispatch();
  },
});

export const dixous = Dixous.create({
  extensions: [
    xml,
    query,
    retry,
  ],
  retryAttempts: 3,
});
```

Use the extended client anywhere:

```ts
import { dixous } from "./lib/dixous";
import { z } from "zod";

const Catalog = z.object({
  catalog: z.object({
    book: z.array(
      z.object({
        title: z.string(),
      }),
    ),
  }),
});

const result = await dixous
  .request(
    "https://example.com/catalog",
    {
      query: {
        author: "Ursula K. Le Guin",
      },
    },
  )
  .xml(Catalog);

console.log(result.catalog.book);
// { title: string }[]
```

The XML example uses [Schema XML](https://github.com/Asguho/schema-xml) and Zod (`npm install schema-xml zod`).

See [Extensions](./docs/extensions.md) for middleware ordering, `dispatch()`, custom terminals, extension state, retries, and more advanced extension patterns.
## Errors and raw responses

Terminal methods reject like ordinary promises. If you prefer to handle failures as values, call `.result()` on the terminal:

```ts
const result = await dixous
  .request("users/1")
  .json(User)
  .result();

if (result.ok) {
  console.log(result.value.name);
} else {
  console.error(result.error);
}
```

`.result()` observes the same request invocation. It does not send the request again.

Built-in body methods such as `.json()`, `.text()`, and `.blob()` expect a successful HTTP response. When the response status itself is part of your application logic, use `.response()` as the escape hatch:

```ts
const response = await dixous
  .request("users/1")
  .response();

if (response.status === 404) {
  // Handle an expected missing user.
} else if (response.ok) {
  const user = await response.json();
}
```

`.response()` returns the native `Response` without applying an HTTP status policy, so responses such as `404`, `409`, and `500` are returned normally.


## Development

```sh
npm ci
npm test
```

See [RELEASING.md](./RELEASING.md) for npm and JSR publishing.
