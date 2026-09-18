# Dixous

A minimal, fully type and extendable fetch client. From your first reqeust to your distrubted cache - Dixous enables you.

## Usage

```ts
import { dixous } from "some-path";
import { z } from "zod";

const image = dixous.fetch("some-url").blob()

// or

const User = z.object({
  id: z.number(),
  name: z.string(),
});

const api = dixous({
  baseUrl: "https://api.example.com/",
  headers: { accept: "application/json" },
});

const pending = api.fetch("users/1"); // No network request yet
const user = await pending.json(User); // Fetch, validate, and infer the type
console.log(user.name); // string

const status = await api.fetch("status").text();
const avatar = await api.fetch("users/1/avatar").blob();
```


# Fully extendable

```ts
// define your own handlers
const xml = defineExtension([USE xmlod])

// add your own logging, retry, caching etc. with custom middleware
const retry = defineExtension([SIMPLE correct retry])

// add your own typed options
const query = defineExtension([SIMPLE correct params helper])

const dixous = createDixous({
  extensions: [
    xml,
    retry,
    query
  ]
})

// Usage

const client = dixous({retryAttempts: 3})

const res = client.fetch(some-url, {some-header, query: {a: "b", c: "d"}}).xml(schema)

```
