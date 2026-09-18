import assert from "node:assert/strict";
import test from "node:test";
import { createDixous, defineExtension, HttpError, SchemaValidationError } from "../dist/index.js";

const url = "https://example.com/resource";
const schema = validate => ({ "~standard": { version: 1, vendor: "test", validate } });

test("default body methods execute independent operations and preserve native results", async () => {
  const responses = [];
  const dixous = createDixous({ fetch: async () => {
    const response = new Response("hello", { headers: { "content-type": "text/plain" } });
    responses.push(response);
    return response;
  } });
  const pending = dixous({ baseUrl: "https://example.com" }).fetch("/resource");
  assert.equal(responses.length, 0);
  assert.equal(await pending.text(), "hello");
  const blob = await pending.blob();
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "hello");
  const buffer = await pending.arrayBuffer();
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(new TextDecoder().decode(buffer), "hello");
  const response = await pending.response();
  assert.equal(response, responses[3]);
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), "hello");
  assert.equal(await pending.text(), "hello");
  assert.equal(responses.length, 5);
});

test("JSON validates parsed data and returns transformed synchronous or asynchronous output", async () => {
  const dixous = createDixous({ fetch: async () => new Response('{"count":"42"}') });
  const pending = dixous.fetch(url);
  const sync = schema(input => {
    assert.deepEqual(input, { count: "42" });
    return { value: { count: Number(input.count) } };
  });
  const asyncSchema = schema(async input => ({ value: Number(input.count) }));
  assert.deepEqual(await pending.json(sync), { count: 42 });
  assert.equal(await pending.json(asyncSchema), 42);
  assert.equal(await pending.json(schema(() => ({ value: undefined }))), undefined);
});

test("validation errors preserve all Standard Schema issues including paths", async () => {
  const issues = [
    { message: "Expected number", path: [{ key: "count" }] },
    { message: "Missing name", path: ["name"] },
  ];
  const dixous = createDixous({ fetch: async () => new Response("{}") });
  for (const validate of [() => ({ issues }), async () => ({ issues })]) {
    await assert.rejects(dixous.fetch(url).json(schema(validate)), error => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.name, "SchemaValidationError");
      assert.equal(error.issues, issues);
      return true;
    });
  }
  // A failure result remains a failure even if its issues array is empty.
  await assert.rejects(dixous.fetch(url).json(schema(() => ({ issues: [] }))), SchemaValidationError);
});

test("native JSON errors and thrown or rejected validator errors propagate unchanged", async () => {
  let validated = false;
  const invalid = createDixous({ fetch: async () => new Response("not JSON") });
  await assert.rejects(invalid.fetch(url).json(schema(value => {
    validated = true;
    return { value };
  })), SyntaxError);
  assert.equal(validated, false);

  const failure = new Error("validator failed");
  const valid = createDixous({ fetch: async () => new Response("{}") });
  for (const validate of [() => { throw failure; }, async () => { throw failure; }]) {
    await assert.rejects(valid.fetch(url).json(schema(validate)), error => error === failure);
  }
});

test("every default method passes through the HTTP status gate before reading the body", async () => {
  let validated = false;
  const validator = schema(value => { validated = true; return { value }; });
  for (const method of ["json", "text", "blob", "arrayBuffer", "response"]) {
    const response = new Response("not JSON", { status: 503 });
    const dixous = createDixous({ fetch: async () => response });
    const pending = dixous.fetch(url);
    const operation = method === "json" ? pending.json(validator) : pending[method]();
    await assert.rejects(operation, error => error instanceof HttpError && error.response === response);
    assert.equal(response.bodyUsed, false);
  }
  assert.equal(validated, false);
});

test("default JSON parsing and validation happen after middleware fully unwinds", async () => {
  const events = [];
  const response = new Response("{}");
  const parse = response.json.bind(response);
  response.json = () => { events.push("parse"); return parse(); };
  const dixous = createDixous({
    extensions: [defineExtension({ request: async (_, next) => {
      events.push("before");
      try { return await next(); }
      catch (error) { events.push("caught"); throw error; }
      finally { events.push("after"); }
    } })],
    fetch: async () => { events.push("transport"); return response; },
  });
  await assert.rejects(dixous.fetch(url).json(schema(async () => {
    events.push("validate");
    return { issues: [{ message: "invalid" }] };
  })), SchemaValidationError);
  assert.deepEqual(events, ["before", "transport", "after", "parse", "validate"]);
});
