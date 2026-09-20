import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dixous, defineExtension, UnexpectedResponseError, ResponseValidationError } from '../dist/index.js';

const url = 'https://example.com/';
const schema = validate => ({ '~standard': { version: 1, vendor: 'test', validate } });
const operation = response => Dixous.create({ fetch: async () => response }).request(url);

test('response returns non-OK native responses; default body helpers enforce status', async () => {
  for (const method of ['json', 'text', 'blob', 'arrayBuffer']) {
    const response = new Response('error', { status: 403 });
    const pending = operation(response);
    assert.equal(await pending.response(), response);
    await assert.rejects(pending[method](schema(() => { throw new Error('must not validate'); })), error => {
      assert.ok(error instanceof UnexpectedResponseError);
      assert.equal(error.name, 'UnexpectedResponseError');
      assert.equal(error.response, response);
      assert.equal(error.request.url, url);
      assert.equal(response.bodyUsed, false);
      return true;
    });
  }
});

test('default readers retain native body behavior', async () => {
  assert.equal(await operation(new Response('text')).text(), 'text');
  assert.equal(await (await operation(new Response('blob')).blob()).text(), 'blob');
  assert.equal(new TextDecoder().decode(await operation(new Response('buffer')).arrayBuffer()), 'buffer');
  const pending = operation(new Response('once'));
  await (await pending.response()).text();
  await assert.rejects(pending.text(), TypeError);
});

test('JSON validates synchronously or asynchronously and returns transformed output', async () => {
  for (const asyncValidation of [false, true]) {
    const validate = value => ({ value: { count: Number(value.count) } });
    const validator = schema(asyncValidation ? async value => validate(value) : validate);
    assert.deepEqual(await operation(Response.json({ count: '3' })).json(validator), { count: 3 });
  }
});

test('validation errors retain issues, final request, and native response', async () => {
  for (const issues of [[], [{ message: 'invalid', path: ['count', { key: 0 }] }]]) {
    const response = Response.json({ count: false });
    const request = new Request(`${url}replacement`);
    const pending = Dixous.create({ fetch: async () => response, extensions: [defineExtension({ async request(context, next) { context.request = request; return next(); } })] }).request(url);
    await assert.rejects(pending.json(schema(async () => ({ issues }))), error => {
      assert.ok(error instanceof ResponseValidationError);
      assert.equal(error.name, 'ResponseValidationError');
      assert.equal(error.request, request);
      assert.equal(error.response, response);
      assert.equal(error.issues, issues);
      return true;
    });
  }
});

test('schema exceptions and platform errors are preserved', async () => {
  const error = new Error('schema bug');
  for (const validate of [() => { throw error; }, async () => { throw error; }]) {
    await assert.rejects(operation(Response.json({})).json(schema(validate)), value => value === error);
  }
  await assert.rejects(operation(new Response('bad json')).json(schema(value => ({ value }))), SyntaxError);
});
