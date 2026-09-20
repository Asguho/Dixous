# Dixous

A small, fully typed HTTP client built on Fetch.

Dixous gives you runtime-validated responses, composable clients, and an extension system that can change how requests execute and what APIs are available on them.

## Installation

```sh
npm install dixous
```

## Quick start

```ts
import { Dixous } from "dixous"
import { z } from "zod"

const api = Dixous.create({
  baseUrl: "https://api.example.com/",
  headers: {
    Authorization: "Bearer YOUR_API_TOKEN",
  },
})

const User = z.object({
  id: z.number(),
  name: z.string(),
})

const user = await api
  .request("users/1")
  .json(User)

console.log(user.name)
```

The response is validated at runtime and inferred automatically from the schema.

Dixous works with any [Standard Schema](https://standardschema.dev/) validator.

## Why Dixous?

Dixous tries to stay small without becoming limiting.

* Built around native `Request` and `Response`
* Runtime validation with full TypeScript inference
* Immutable clients that compose and specialize naturally
* Extensions can add options, wrap request execution, and add request APIs
* Features such as retries, caching, logging, authentication, and custom formats stay outside the core
* Drop down to the native `Response` whenever you need to

## Extend the request API

Extensions can add entirely new request methods.

For example, [Schema XML](https://github.com/Asguho/schema-xml) can make XML feel like a native Dixous response format:

```ts
import {
  Dixous,
  defineExtension,
} from "dixous"
import { parseXml } from "schema-xml"
import { z } from "zod"

const xml = defineExtension({
  operation(operation) {
    return {
      async xml<Schema extends z.ZodType>(
        schema: Schema,
      ): Promise<z.output<Schema>> {
        const response = await operation.response()

        if (!response.ok) {
          throw new Error(
            `Unexpected response: ${response.status}`,
          )
        }

        return parseXml(
          await response.text(),
          schema,
        )
      },
    }
  },
})

const api = Dixous.create({
  extensions: [xml],
})

const Catalog = z.object({
  catalog: z.object({
    book: z.array(
      z.object({
        title: z.string(),
      }),
    ),
  }),
})

const catalog = await api
  .request("https://example.com/catalog.xml")
  .xml(Catalog)

console.log(catalog.catalog.book)
// { title: string }[]
```

Dixous itself knows nothing about XML. Installing the extension adds `.xml(schema)` directly to the request type with full inference.

## Composable by design

Create one shared Dixous client for your application, then import and specialize it where needed.

```ts
// lib/dixous.ts

import { Dixous } from "dixous"

export const dixous = Dixous.create({
  baseUrl: "https://api.example.com/",
  extensions: [
    retry(),
    query(),
  ],
})
```

Elsewhere:

```ts
import { dixous } from "./lib/dixous"

const github = dixous.create({
  baseUrl: "https://api.github.com/",
  headers: {
    Authorization: `Bearer ${token}`,
  },
  retryAttempts: 5,
})

const users = await github
  .request("users", {
    query: {
      since: "100",
    },
  })
  .json(Users)
```

Derived clients inherit their parent's configuration, extensions, and types, while more specific configuration overrides shared defaults. The parent client is never changed.

## Extend request behavior

Extensions can also change how requests execute and contribute their own typed options.

```ts
const query = defineExtension<{
  query?: Record<string, string>
}>()({
  async request(context, next) {
    const url = new URL(context.request.url)

    for (const [key, value] of Object.entries(context.options.query ?? {})) {
      url.searchParams.append(key, value)
    }

    context.request = new Request(
      url,
      context.request,
    )

    return next()
  },
})
```

Install it:

```ts
const api = Dixous.create({
  extensions: [query],
})
```

And the option becomes part of the client:

```ts
const books = await api
  .request("books", {
    query: {
      author: "Ursula K. Le Guin",
    },
  })
  .json(Books)
```

Without the extension, `query` is not part of the request options.

The same mechanism can power retries, authentication, caching, logging, tracing, rate limiting, and more.

## Native when you need it

Use `.response()` whenever the HTTP response itself is part of your application logic:

```ts
const response = await api
  .request("users/1")
  .response()

if (response.status === 404) {
  // Handle an expected missing user.
}

if (response.ok) {
  const body = await response.json()
}
```

It returns the final native `Response` without applying a status policy.

Requests are lazy and memoized per `request()` call, while response bodies keep their normal native consumption semantics.

See [Extensions](./docs/extensions.md) for middleware ordering, retries, caching, logging, custom formats, extension state, and advanced composition.
