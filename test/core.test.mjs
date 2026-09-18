import assert from "node:assert/strict";
import test from "node:test";
import { createContextKey, createDixous, defineExtension, HttpError } from "../dist/index.js";

const url = "https://example.com/resource";
function setup(extensions = [], transport = async () => new Response("ok")) {
  const requests = [];
  const dixous = createDixous({
    extensions,
    fetch: request => {
      requests.push(request);
      return transport(request);
    },
  });
  return { dixous, requests };
}

test("pending construction and method factories are lazy", async () => {
  const events = [];
  const dixous = createDixous({
    extensions: [defineExtension({
      request: async (_, next) => { events.push("middleware"); return next(); },
      methods: {
        read: fetchResponse => {
          events.push("factory");
          return async execute => {
            events.push("method");
            return execute ? (await fetchResponse()).text() : "local";
          };
        },
      },
    })],
    fetch: async () => { events.push("transport"); return new Response("ok"); },
  });
  const pending = dixous.fetch(url);
  assert.deepEqual(events, []);
  assert.equal(await pending.read(false), "local");
  assert.deepEqual(events, ["factory", "method"]);
  assert.equal(await pending.read(true), "ok");
  assert.deepEqual(events, ["factory", "method", "factory", "method", "middleware", "transport"]);
});

test("invalid pending requests fail synchronously without execution", async () => {
  const { dixous, requests } = setup();
  assert.throws(() => dixous.fetch("not an absolute URL"), TypeError);
  assert.throws(() => dixous.fetch(url, { method: "GET", body: "invalid" }), TypeError);
  assert.throws(() => dixous.fetch(url, { headers: { "bad name": "invalid" } }), TypeError);
  const consumed = new Request(url, { method: "POST", body: "used" });
  await consumed.text();
  assert.throws(() => dixous.fetch(consumed), TypeError);
  assert.equal(requests.length, 0);
});

test("URL resolution is native and Request input ignores baseUrl", async () => {
  const { dixous, requests } = setup();
  const api = dixous({ baseUrl: "https://base.example/v1/" });
  await api.fetch("users").text();
  await api.fetch("/users").text();
  await api.fetch("https://other.example/users").text();
  await api.fetch(new URL("https://url.example/users")).text();
  await api.fetch(new Request(url)).text();
  assert.deepEqual(requests.map(request => request.url), [
    "https://base.example/v1/users", "https://base.example/users",
    "https://other.example/users", "https://url.example/users", url,
  ]);
});

test("headers merge by name with client, input, options, middleware precedence", async () => {
  const { dixous, requests } = setup([defineExtension({
    request: async (context, next) => {
      context.request.headers.set("shared", "middleware");
      return next();
    },
  })]);
  const api = dixous({ headers: { client: "kept", layered: "client", shared: "client" } });
  const input = new Request(url, {
    method: "POST", body: "payload", credentials: "include",
    headers: { input: "kept", layered: "input", shared: "input", overridden: "input" },
  });
  await api.fetch(input, {
    method: "PUT", credentials: "omit",
    headers: [["option", "kept"], ["SHARED", "options"], ["overridden", "options"]],
  }).text();
  const request = requests[0];
  assert.equal(request.method, "PUT");
  assert.equal(request.credentials, "omit");
  assert.equal(await request.text(), "payload");
  assert.deepEqual(Object.fromEntries(request.headers), {
    client: "kept", "content-type": "text/plain;charset=UTF-8", input: "kept",
    layered: "input", option: "kept", overridden: "options", shared: "middleware",
  });
});

test("client and pending request snapshots isolate caller-owned native values", async () => {
  const contexts = [];
  const { dixous, requests } = setup([defineExtension({
    request: async (context, next) => { contexts.push(context); return next(); },
  })]);
  const baseUrl = new URL("https://original.example/v1/");
  const clientHeaders = new Headers({ client: "original" });
  const nestedClient = { token: "original" };
  const clientOptions = { baseUrl, headers: clientHeaders, auth: nestedClient };
  const api = dixous(clientOptions);
  baseUrl.hostname = "changed.example";
  clientHeaders.set("client", "changed");
  clientOptions.baseUrl = "https://replaced.example";
  clientOptions.auth = {};
  const input = new Request(url, { headers: { input: "original" } });
  const headers = new Headers({ option: "original" });
  const nestedRequest = { attempts: 2 };
  const options = { headers, method: "POST", body: "original", retry: nestedRequest };
  const pending = api.fetch(input, options);
  input.headers.set("input", "changed");
  headers.set("option", "changed");
  options.method = "PUT";
  options.body = "changed";
  options.retry = {};
  nestedClient.token = "nested mutation";
  nestedRequest.attempts = 4;
  await pending.text();
  await api.fetch("users").text();
  assert.equal(requests[0].method, "POST");
  assert.equal(await requests[0].text(), "original");
  assert.equal(requests[0].headers.get("input"), "original");
  assert.equal(requests[0].headers.get("option"), "original");
  assert.equal(requests[0].headers.get("client"), "original");
  assert.equal(requests[1].url, "https://original.example/v1/users");
  const context = contexts[0];
  assert.ok(Object.isFrozen(context.options));
  assert.ok(Object.isFrozen(context.client));
  assert.notEqual(context.options.headers, headers);
  assert.notEqual(context.client.headers, clientHeaders);
  assert.equal(context.options.retry, nestedRequest);
  assert.equal(context.client.auth, nestedClient);
  assert.equal(context.client, contexts[1].client);
  assert.equal(context.options.headers.get("option"), "original");
  assert.throws(() => { context.options.method = "DELETE"; }, TypeError);
  assert.throws(() => { context.client.baseUrl = "changed"; }, TypeError);
});

test("native body buffers and URL input are snapshotted during pending construction", async () => {
  const { dixous, requests } = setup();
  const input = new URL(url);
  const body = new Uint8Array([65, 66]);
  const pending = dixous.fetch(input, { method: "POST", body });
  input.pathname = "/changed";
  body.fill(90);
  await pending.text();
  assert.equal(requests[0].url, url);
  assert.equal(await requests[0].text(), "AB");
});

test("every method call has its own factory, memoized promise, response, and context", async () => {
  const contexts = [];
  const operations = [];
  let requests = 0;
  const dixous = createDixous({
    extensions: [defineExtension({
      request: async (context, next) => { contexts.push(context); return next(); },
      methods: {
        check: fetchResponse => {
          operations.push(fetchResponse);
          return async () => {
            const first = fetchResponse();
            assert.equal(first, fetchResponse());
            const response = await first;
            assert.equal(response, await fetchResponse());
            return response;
          };
        },
      },
    })],
    fetch: async () => { requests++; return new Response("ok"); },
  });
  const pending = dixous.fetch(url);
  const [first, second] = await Promise.all([pending.check(), pending.check()]);
  assert.equal(requests, 2);
  assert.notEqual(first, second);
  assert.notEqual(operations[0], operations[1]);
  assert.notEqual(contexts[0].request, contexts[1].request);
  assert.notEqual(contexts[0].state, contexts[1].state);
});

test("FetchResponse memoizes rejection and is safe against synchronous re-entry", async () => {
  const error = new Error("network failure");
  let fetchResponse;
  let reentered;
  let calls = 0;
  const dixous = createDixous({
    extensions: [defineExtension({
      request: async (_, next) => { reentered = fetchResponse(); return next(); },
      methods: { inspect: fetch => async () => {
        fetchResponse = fetch;
        const promise = fetch();
        await assert.rejects(promise, value => value === error);
        assert.equal(reentered, promise);
        assert.equal(fetch(), promise);
        await assert.rejects(fetch(), value => value === error);
      } },
    })],
    fetch: async () => { calls++; throw error; },
  });
  await dixous.fetch(url).inspect();
  assert.equal(calls, 1);
});

test("middleware registration order unwinds in reverse", async () => {
  const events = [];
  const extensions = ["A", "B", "C"].map(name => defineExtension({
    request: async (_, next) => {
      events.push(`${name} before`);
      const response = await next();
      events.push(`${name} after`);
      return response;
    },
  }));
  const { dixous } = setup(extensions, async () => {
    events.push("transport"); return new Response("ok");
  });
  await dixous.fetch(url).text();
  assert.deepEqual(events, ["A before", "B before", "C before", "transport", "C after", "B after", "A after"]);
});

test("sequential next calls re-enter downstream middleware with current request and shared state", async () => {
  const attempt = createContextKey();
  const events = [];
  const contexts = [];
  const { dixous, requests } = setup([
    defineExtension({ request: async (_, next) => {
      events.push("outer before");
      const response = await next();
      events.push("outer after");
      return response;
    } }),
    defineExtension({ request: async (context, next) => {
      context.state.set(attempt, 1);
      assert.equal((await next()).status, 503);
      context.state.set(attempt, 2);
      context.request = new Request("https://example.com/retry", context.request);
      return next();
    } }),
    defineExtension({ request: async (context, next) => {
      contexts.push(context);
      events.push(`attempt ${context.state.get(attempt)}`);
      const count = Number(context.request.headers.get("count") ?? 0) + 1;
      context.request.headers.set("count", String(count));
      return next();
    } }),
  ], async request => new Response(await request.text(), {
    status: request.url.endsWith("/retry") ? 200 : 503,
  }));
  const pending = dixous.fetch(url, { method: "POST", body: "payload" });
  assert.equal(await pending.text(), "payload");
  assert.deepEqual(events, ["outer before", "attempt 1", "attempt 2", "outer after"]);
  assert.equal(contexts[0], contexts[1]);
  assert.equal(requests[0].headers.get("count"), "1");
  assert.equal(requests[1].headers.get("count"), "2");
  assert.notEqual(requests[1], contexts[1].request);
  assert.equal(contexts[1].request.bodyUsed, false);
  assert.equal(await pending.text(), "payload");
  assert.equal(requests[2].headers.get("count"), "1");
  assert.notEqual(contexts[0].state, contexts[2].state);
});

test("a rejected downstream traversal releases the next guard for retry", async () => {
  const failure = new Error("offline");
  let attempts = 0;
  const { dixous } = setup([defineExtension({ request: async (_, next) => {
    await assert.rejects(next(), value => value === failure);
    return next();
  } })], async () => {
    if (++attempts === 1) throw failure;
    return new Response("recovered");
  });
  assert.equal(await dixous.fetch(url).text(), "recovered");
  assert.equal(attempts, 2);
});

test("overlapping calls to the same next are rejected before another traversal", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { dixous, requests } = setup([defineExtension({ request: async (_, next) => {
    const first = next();
    await assert.rejects(next(), /Overlapping next\(\) calls/);
    release();
    return first;
  } })], async () => { await blocked; return new Response("ok"); });
  assert.equal(await dixous.fetch(url).text(), "ok");
  assert.equal(requests.length, 1);
});

test("context keys are unique and state is operation-local", async () => {
  const first = createContextKey();
  const second = createContextKey();
  assert.equal(typeof first, "symbol");
  assert.notEqual(first, second);
  assert.equal(Symbol.keyFor(first), undefined);
  const { dixous } = setup([
    defineExtension({ request: async (context, next) => {
      assert.equal(context.state.get(first), undefined);
      context.state.set(first, 42);
      return next();
    } }),
    defineExtension({ request: async (context, next) => {
      assert.equal(context.state.get(first), 42);
      assert.equal(context.state.get(second), undefined);
      return next();
    } }),
  ]);
  const pending = dixous.fetch(url);
  await Promise.all([pending.text(), pending.text()]);
});

test("HTTP status gate runs after all middleware and captures the canonical final request", async () => {
  const events = [];
  const failure = new Response("unavailable", { status: 503 });
  let canonical;
  const { dixous, requests } = setup([defineExtension({ request: async (context, next) => {
    const response = await next();
    events.push(response.status);
    context.request = new Request("https://example.com/final", context.request);
    canonical = context.request;
    return response;
  } })], async () => failure);
  await assert.rejects(dixous.fetch(url).text(), error => {
    assert.ok(error instanceof HttpError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "HttpError");
    assert.equal(error.status, 503);
    assert.equal(error.response, failure);
    assert.equal(error.request, canonical);
    assert.equal(error.request.url, "https://example.com/final");
    return true;
  });
  assert.deepEqual(events, [503]);
  assert.equal(requests[0].url, url);
  assert.equal(failure.bodyUsed, false);
});

test("middleware can transform non-OK results before the status gate", async () => {
  const { dixous } = setup([defineExtension({ request: async (_, next) => {
    const response = await next();
    assert.equal(response.status, 304);
    return new Response("cached");
  } })], async () => new Response(null, { status: 304 }));
  assert.equal(await dixous.fetch(url).text(), "cached");
});

test("short circuits pass through outer middleware and the status gate", async () => {
  let unwound = false;
  const { dixous, requests } = setup([
    defineExtension({ request: async (_, next) => {
      const response = await next(); unwound = true; return response;
    } }),
    defineExtension({ request: async () => new Response(null, { status: 429 }) }),
  ]);
  await assert.rejects(dixous.fetch(url).text(), error => error instanceof HttpError && error.status === 429);
  assert.equal(unwound, true);
  assert.equal(requests.length, 0);
  const success = setup([defineExtension({ request: async () => new Response("local") })]);
  assert.equal(await success.dixous.fetch(url).text(), "local");
  assert.equal(success.requests.length, 0);
});

test("method prevalidation and parsing errors occur outside request middleware", async () => {
  const events = [];
  const invalidSchema = new Error("invalid schema");
  const dixous = createDixous({
    extensions: [defineExtension({
      request: async (_, next) => {
        events.push("before");
        try { return await next(); }
        catch (error) { events.push("caught"); throw error; }
        finally { events.push("after"); }
      },
      methods: { parse: fetchResponse => async valid => {
        if (!valid) throw invalidSchema;
        const response = await fetchResponse();
        events.push("parse");
        return response.json();
      } },
    })],
    fetch: async () => new Response("not JSON"),
  });
  const pending = dixous.fetch(url);
  await assert.rejects(pending.parse(false), error => error === invalidSchema);
  assert.deepEqual(events, []);
  await assert.rejects(pending.parse(true), SyntaxError);
  assert.deepEqual(events, ["before", "after", "parse"]);
});

test("core never clones responses or buffers consumed response bodies", async () => {
  const response = new Response("body");
  response.clone = () => { throw new Error("must not clone response"); };
  const dixous = createDixous({
    extensions: [defineExtension({ methods: { read: fetchResponse => async () => {
      assert.equal(await fetchResponse(), response);
      assert.equal(await (await fetchResponse()).text(), "body");
      await assert.rejects((await fetchResponse()).text(), TypeError);
    } } })],
    fetch: async () => response,
  });
  await dixous.fetch(url).read();
});

test("middleware can inspect request and response clones without consuming canonical bodies", async () => {
  const { dixous } = setup([defineExtension({ request: async (context, next) => {
    assert.equal(await context.request.clone().text(), "request body");
    const response = await next();
    assert.equal(await response.clone().text(), "response body");
    return response;
  } })], async request => {
    assert.equal(await request.text(), "request body");
    return new Response("response body");
  });
  assert.equal(await dixous.fetch(url, { method: "POST", body: "request body" }).text(), "response body");
});

test("transport and middleware errors propagate unchanged without core retries", async () => {
  const failure = new Error("failure");
  const network = setup([], async () => { throw failure; });
  await assert.rejects(network.dixous.fetch(url).text(), error => error === failure);
  assert.equal(network.requests.length, 1);
  const middleware = setup([defineExtension({ request: async () => { throw failure; } })]);
  await assert.rejects(middleware.dixous.fetch(url).text(), error => error === failure);
  assert.equal(middleware.requests.length, 0);
  const status = setup([], async () => new Response(null, { status: 500 }));
  await assert.rejects(status.dixous.fetch(url).text(), HttpError);
  assert.equal(status.requests.length, 1);
});

test("caller abort remains linked through snapshots, clones, and request replacement", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let canonical;
  const { dixous, requests } = setup([defineExtension({ request: async (context, next) => {
    context.request = new Request("https://example.com/replaced", context.request);
    canonical = context.request;
    return next();
  } })], async request => { request.signal.throwIfAborted(); return new Response("ok"); });
  const pending = dixous.fetch(url, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending.text(), error => error === reason);
  assert.equal(canonical.signal.reason, reason);
  assert.equal(requests[0].signal.reason, reason);
});

test("in-flight abort reaches the transport", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { dixous } = setup([], request => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    started();
  }));
  const operation = dixous.fetch(url, { signal: controller.signal }).text();
  await ready;
  const reason = new Error("stop");
  controller.abort(reason);
  await assert.rejects(operation, error => error === reason);
});

test("middleware can deliberately replace cancellation semantics", async () => {
  const original = new AbortController();
  const replacement = new AbortController();
  const { dixous } = setup([defineExtension({ request: async (context, next) => {
    context.request = new Request(context.request, { signal: replacement.signal });
    return next();
  } })], async request => { request.signal.throwIfAborted(); return new Response("ok"); });
  const pending = dixous.fetch(url, { signal: original.signal });
  original.abort();
  assert.equal(await pending.text(), "ok");
});

test("extension registrations and transport are captured during composition", async () => {
  const events = [];
  const extension = defineExtension({
    request: async (_, next) => { events.push("original"); return next(); },
    methods: { custom: fetchResponse => async () => (await fetchResponse()).text() },
  });
  const extensions = [extension];
  const options = { extensions, fetch: async () => new Response("original transport") };
  const dixous = createDixous(options);
  extension.request = async () => new Response("changed middleware");
  extension.methods.custom = () => async () => "changed method";
  extension.methods.added = () => async () => "added";
  extensions.push(defineExtension({ request: async () => new Response("added middleware") }));
  options.fetch = async () => new Response("changed transport");
  const pending = dixous.fetch(url);
  assert.deepEqual(Object.keys(pending), ["json", "text", "blob", "arrayBuffer", "response", "custom"]);
  assert.equal(await pending.custom(), "original transport");
  assert.deepEqual(events, ["original"]);
});

test("default global transport is captured at composition", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("captured");
    const dixous = createDixous();
    globalThis.fetch = async () => new Response("changed");
    assert.equal(await dixous.fetch(url).text(), "captured");
  } finally { globalThis.fetch = original; }
});

test("duplicate method names fail during composition", () => {
  const custom = defineExtension({ methods: { custom: () => async () => "custom" } });
  assert.throws(() => createDixous({ extensions: [custom, custom] }), /Duplicate response method: custom/);
  for (const name of ["json", "text", "blob", "arrayBuffer", "response"]) {
    const extension = defineExtension({ methods: { [name]: () => async () => "override" } });
    assert.throws(() => createDixous({ extensions: [extension] }), {
      message: `Duplicate response method: ${name}`,
    });
  }
});

test("pending method objects are immutable and handle Object prototype names", async () => {
  const special = defineExtension({ methods: {
    ["__proto__"]: () => async () => "proto",
    constructor: () => async () => "constructor",
  } });
  const { dixous } = setup([special]);
  const pending = dixous.fetch(url);
  assert.ok(Object.isFrozen(pending));
  assert.throws(() => { pending.text = () => {}; }, TypeError);
  assert.throws(() => { pending.added = () => {}; }, TypeError);
  assert.throws(() => { delete pending.text; }, TypeError);
  assert.equal(await pending.__proto__(), "proto");
  assert.equal(await pending.constructor(), "constructor");
});

test("root and configured fetchers keep independent client configurations", async () => {
  const contexts = [];
  const { dixous, requests } = setup([defineExtension({ request: async (context, next) => {
    contexts.push(context); return next();
  } })]);
  const first = dixous({ baseUrl: "https://first.example/", headers: { client: "first" } });
  const pending = first.fetch("resource");
  const second = dixous({ baseUrl: "https://second.example/", headers: { client: "second" } });
  await second.fetch("resource").text();
  await pending.text();
  await dixous.fetch(url).text();
  assert.deepEqual(requests.map(request => request.headers.get("client")), ["second", "first", null]);
  assert.equal(requests[1].url, "https://first.example/resource");
  assert.deepEqual(contexts[2].client, {});
});

test("an empty composition exposes defaults without executing", () => {
  let called = false;
  const dixous = createDixous({ fetch: async () => { called = true; return new Response(); } });
  assert.deepEqual(Object.keys(dixous.fetch(url)), ["json", "text", "blob", "arrayBuffer", "response"]);
  assert.equal(called, false);
});
