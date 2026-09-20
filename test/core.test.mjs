import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dixous, defineExtension, ConcurrentNextError } from '../dist/index.js';

const url = 'https://example.com/';

test('operations construct requests eagerly and execute once, lazily', async () => {
  let calls = 0;
  let context;
  let factories = 0;
  const response = new Response('body');
  const api = Dixous.create({
    baseUrl: url,
    fetch: async request => { calls++; assert.equal(request, context.request); return response; },
    extensions: [defineExtension({ operation(operation) {
      factories++;
      context = operation;
      return { status: async () => (await operation.response()).status };
    } })],
  });
  const operation = api.request('test');
  assert.equal(factories, 1);
  assert.ok(context.request instanceof Request);
  assert.equal(context.request.url, `${url}test`);
  assert.equal(calls, 0);
  assert.equal(await Promise.resolve(operation), operation);
  assert.equal(await Promise.resolve(api), api);
  assert.equal(calls, 0);
  const first = operation.response();
  assert.equal(first, operation.response());
  assert.equal(first, context.response());
  assert.equal(await first, response);
  assert.equal(await operation.status(), 200);
  assert.equal(await operation.text(), 'body');
  await assert.rejects(operation.text(), TypeError);
  assert.equal(calls, 1);
  await api.request('other').response();
  assert.equal(calls, 2);
  assert.throws(() => api.request('/', { method: 'GET', body: 'bad' }), TypeError);
});

test('rejections and synchronous transport failures are memoized', async () => {
  const error = new Error('offline');
  let calls = 0;
  const operation = Dixous.create({ fetch() { calls++; throw error; } }).request(url);
  await assert.rejects(operation.response(), value => value === error);
  await assert.rejects(operation.text(), value => value === error);
  assert.equal(calls, 1);
});

test('derived clients inherit defaults, append extensions, and merge headers by name', async () => {
  const seen = [];
  const order = [];
  const layer = name => defineExtension({ async request(context, next) {
    order.push(`${name} before`);
    seen.push(context);
    const response = await next();
    order.push(`${name} after`);
    return response;
  } });
  const headers = { Authorization: 'parent', 'x-parent': 'yes' };
  const baseUrl = new URL(`${url}root/`);
  const extensions = [layer('A')];
  const api = Dixous.create({ baseUrl, headers, label: 'parent', extensions,
    fetch: async () => { order.push('transport'); return new Response(); } });
  headers.Authorization = 'mutated';
  baseUrl.pathname = '/mutated/';
  extensions.push(layer('unexpected'));
  const child = api.create({ headers: { authorization: 'child', 'x-child': 'yes' }, label: 'child', extensions: [layer('B')] });
  const requestOptions = { headers: { 'X-CHILD': 'request' }, label: 'request' };
  const operation = child.request('../item', requestOptions);
  requestOptions.label = 'mutated';
  requestOptions.headers['X-CHILD'] = 'mutated';
  await operation.response();
  const context = seen[0];
  assert.equal(context.request.url, `${url}item`);
  assert.deepEqual(order, ['A before', 'B before', 'transport', 'B after', 'A after']);
  assert.equal(context.options.label, 'request');
  assert.ok(Object.isFrozen(context.options));
  assert.equal(context.options.extensions, undefined);
  assert.equal(context.request.headers.get('authorization'), 'child');
  assert.equal(context.request.headers.get('x-child'), 'request');
  assert.equal(context.request.headers.get('x-parent'), 'yes');
  seen.length = 0;
  order.length = 0;
  await api.request('item').response();
  assert.equal(seen[0].request.url, `${url}root/item`);
  assert.equal(seen[0].options.label, 'parent');
  assert.equal(seen[0].request.headers.get('authorization'), 'parent');
  assert.deepEqual(order, ['A before', 'transport', 'A after']);
});

test('Request inputs merge headers and preserve original input through replacement', async () => {
  const input = new Request(`${url}original`, { method: 'POST', body: 'payload', headers: { 'x-input': 'yes', 'x-default': 'input' } });
  let context;
  const replacement = new Request(`${url}replacement`);
  const api = Dixous.create({ baseUrl: 'https://other.example/', headers: { 'x-default': 'default' },
    extensions: [defineExtension({ async request(ctx, next) { context = ctx; ctx.request = replacement; return next(); } })],
    fetch: async request => { assert.equal(request, replacement); return new Response(); },
  });
  const operation = api.request(input, { headers: { 'x-input': 'request' } });
  await operation.response();
  assert.equal(context.input, input);
  assert.equal(context.options.headers.get('x-input'), 'request');
  assert.equal(context.options.headers.get('x-default'), 'input');
  assert.equal(context.request, replacement);
  assert.throws(() => { context.input = url; }, TypeError);
  assert.throws(() => { context.options = {}; }, TypeError);
});

test('sequential next calls rerun downstream middleware and allow request replacement', async () => {
  let attempts = 0;
  let downstream = 0;
  const bodies = [];
  const retry = defineExtension({ async request(context, next) {
    const first = await next();
    assert.equal(first.status, 503);
    context.request = new Request(url, { method: 'POST', body: 'second' });
    return next();
  } });
  const api = Dixous.create({ extensions: [retry, defineExtension({ async request(context, next) { downstream++; return next(); } })],
    fetch: async request => { bodies.push(await request.text()); return new Response(null, { status: ++attempts === 1 ? 503 : 200 }); },
  });
  const operation = api.request(url, { method: 'POST', body: 'first' });
  await operation.response();
  await operation.response();
  assert.equal(downstream, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(bodies, ['first', 'second']);
});

test('Dixous does not clone or buffer requests for retries', async () => {
  const api = Dixous.create({ extensions: [defineExtension({ async request(context, next) { await next(); return next(); } })],
    fetch: async request => new Response(await request.text()),
  });
  await assert.rejects(api.request(url, { method: 'POST', body: 'one shot' }).response(), TypeError);
});

test('concurrent next calls reject with ConcurrentNextError; sequential calls recover', async () => {
  let calls = 0;
  const api = Dixous.create({ fetch: async () => { calls++; return new Response(); },
    extensions: [defineExtension({ async request(context, next) {
      const first = next();
      await assert.rejects(next(), ConcurrentNextError);
      await first;
      return next();
    } })],
  });
  await api.request(url).response();
  assert.equal(calls, 2);
});

test('next guards reset after rejection, and middleware can short circuit', async () => {
  let calls = 0;
  const error = new Error('retry');
  const api = Dixous.create({ fetch: async () => { if (++calls === 1) throw error; return new Response('ok'); },
    extensions: [defineExtension({ async request(context, next) {
      await assert.rejects(next(), value => value === error);
      return next();
    } })],
  });
  assert.equal(await api.request(url).text(), 'ok');
  const short = Dixous.create({ fetch: () => { throw new Error('unreachable'); }, extensions: [defineExtension({ async request() { return new Response('cached'); } })] });
  assert.equal(await short.request(url).text(), 'cached');
});

test('operation factories compose once in order, with later overrides and symbol keys', async () => {
  const key = Symbol('helper');
  const order = [];
  const first = defineExtension({ operation() { order.push('first'); return { text: () => 1, [key]: () => 'symbol' }; } });
  const last = defineExtension({ operation(operation) { order.push('last'); return { text: async prefix => prefix + (await operation.response()).status }; } });
  const api = Dixous.create({ extensions: [first], fetch: async () => new Response() });
  const child = api.create({ extensions: [last] });
  const operation = child.request(url);
  assert.deepEqual(order, ['first', 'last']);
  assert.equal(await operation.text('status:'), 'status:200');
  assert.equal(operation[key](), 'symbol');
  assert.equal(api.request(url).text(), 1);
  assert.throws(() => { operation.response = () => {}; }, TypeError);
  const invalid = Dixous.create({ extensions: [{ operation: () => ({ response: () => {} }) }] });
  assert.throws(() => invalid.request(url), /cannot replace response/);
  const then = Dixous.create({ extensions: [{ operation: () => ({ then: () => { throw new Error('thenable'); } }) }] }).request(url);
  assert.equal(await Promise.resolve(then), then);
});

test('native URL resolution, abort signals, and derived transports', async () => {
  const input = new URL(`${url}absolute`);
  const controller = new AbortController();
  let received;
  const api = Dixous.create({ baseUrl: `${url}base/`, fetch: async request => { received = request; return new Response('parent'); } });
  const operation = api.request(input, { signal: controller.signal });
  input.pathname = '/changed';
  controller.abort();
  assert.equal(await operation.text(), 'parent');
  assert.equal(received.url, `${url}absolute`);
  assert.equal(received.signal.aborted, true);
  assert.equal(await api.create({ fetch: async () => new Response('child') }).request('/').text(), 'child');
  assert.equal(await api.request('/').text(), 'parent');
});
