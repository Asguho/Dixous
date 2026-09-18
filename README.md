# Dixous

A minimal, typed Fetch client. From your first request to custom caching, extend it as your application grows.

## Usage

```ts
import { dixous } from "./lib/dixous";
import { z } from "zod";

const image = await dixous.fetch("https://example.com/image.png").blob();

const User = z.object({
  id: z.number(),
  name: z.string(),
});

const api = dixous({ baseUrl: "https://api.example.com/" });
const user = await api.fetch("users/1").json(User);

console.log(user.name); // string, validated at runtime
```

Requests run when you call `.json(schema)`, `.text()`, `.blob()`, `.arrayBuffer()`, or `.response()`. JSON accepts any Standard Schema v1 validator.

## Fully extensible

Define your client once. Add response methods, middleware, and typed options with `defineExtension`.

```ts
// lib/dixous.ts
import { createDixous, defineExtension, type FetchResponse } from "dixous";
import { parseXml } from "@asguho/xmlod";
import { z } from "zod";

// Parse and validate XML with Xmlod.
const xml = defineExtension({
  methods: {
    xml: (fetchResponse: FetchResponse) =>
      async <S extends z.ZodType>(schema: S): Promise<z.output<S>> =>
        parseXml(await (await fetchResponse()).text(), schema),
  },
});

// Retry GET requests up to three times in total on a 503 response.
const retry = defineExtension({
  async request({ request }, next) {
    for (let attempt = 1; ; attempt++) {
      request.signal.throwIfAborted();
      const response = await next();
      if (request.method !== "GET" || response.status !== 503 || attempt === 3) {
        return response;
      }
      await response.body?.cancel();
    }
  },
});

// Add a typed query option.
const query = defineExtension<{ query?: Record<string, string> }>()({
  async request(context, next) {
    const url = new URL(context.request.url);
    for (const [key, value] of Object.entries(context.options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    context.request = new Request(url, context.request);
    return next();
  },
});

export const dixous = createDixous({ extensions: [xml, query, retry] });
```

The XML example uses [Xmlod](https://github.com/Asguho/xmlod) and Zod (`npm install @asguho/xmlod zod`). Use the extended client anywhere:

```ts
import { dixous } from "./lib/dixous";
import { z } from "zod";

const Catalog = z.object({
  catalog: z.object({ book: z.array(z.object({ title: z.string() })) }),
});

const result = await dixous.fetch("https://example.com/catalog", {
  query: { author: "Ursula K. Le Guin" },
}).xml(Catalog);

console.log(result.catalog.book); // { title: string }[]
```

## Development

```sh
npm ci
npm test
```
