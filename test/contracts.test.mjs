import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Dixous, defineExtension, UnexpectedResponseError,
} from '../dist/index.js';

const url = 'https://example.com/root/';
const schema = { '~standard': { version: 1, vendor: 'contract', validate: value => ({ value }) } };
const inspect = defineExtension({ operation: context => ({ context: () => context }) });

test('a client with no options is usable and uses global fetch', async t => {
  const response = new Response('default');
  const fetch = t.mock.method(globalThis, 'fetch', async request => {
    assert.ok(request instanceof Request);
    assert.equal(request.url, url);
    return response;
  });
  const client = Dixous.create();
  const operation = client.request(url);
  for (const method of ['response', 'json', 'text', 'blob', 'arrayBuffer']) {
    assert.equal(typeof operation[method], 'function');
  }
  assert.equal(client.then, undefined);
  assert.equal(operation.then, undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await operation.response(), response);
  assert.equal(fetch.mock.callCount(), 1);
});

test('multiple derivations preserve shared extension state and isolate specialized configuration', async () => {
  let installs = 0;
  const events = [];
  const install = () => {
    installs++;
    let executions = 0;
    return defineExtension({
      async request(context, next) { events.push(++executions); return next(); },
      operation: context => ({ inherited: () => context.options.label }),
    });
  };
  const parentFetch = async () => new Response('parent transport');
  const childFetch = async () => new Response('child transport');
  const parent = Dixous.create({ baseUrl: url, fetch: parentFetch,
    headers: { authorization: 'parent', 'x-common': 'yes' },
    label: 'parent', retained: 42, config: { a: 1, b: 2 },
    extensions: [install(), inspect],
  });
  const child = parent.create({ baseUrl: 'https://child.example/api/', fetch: childFetch,
    headers: { Authorization: 'child' }, label: 'child', config: { a: 3 },
    extensions: [defineExtension({ operation: () => ({ extra: () => 'extra' }) })],
  });
  const grandchild = child.create().create();
  const sibling = parent.create();
  assert.notEqual(parent.create(), parent);
  assert.notEqual(child, parent);
  assert.notEqual(grandchild, child);
  for (const [client, expectedUrl, auth, label, config, transport] of [
    [grandchild, 'https://child.example/api/item', 'child', 'child', { a: 3 }, childFetch],
    [sibling, `${url}item`, 'parent', 'parent', { a: 1, b: 2 }, parentFetch],
    [parent, `${url}item`, 'parent', 'parent', { a: 1, b: 2 }, parentFetch],
  ]) {
    const operation = client.request('item');
    const context = operation.context();
    assert.equal(context.request.url, expectedUrl);
    assert.equal(context.request.headers.get('authorization'), auth);
    assert.equal(context.request.headers.get('x-common'), 'yes');
    assert.equal(context.options.retained, 42);
    assert.equal(context.options.fetch, transport);
    assert.deepEqual(context.options.config, config);
    assert.equal(operation.inherited(), label);
    assert.equal(await operation.text(), transport === childFetch ? 'child transport' : 'parent transport');
  }
  assert.equal(grandchild.request('item').extra(), 'extra');
  assert.equal(parent.request('item').extra, undefined);
  assert.equal(installs, 1);
  assert.deepEqual(events, [1, 2, 3]);
  const override = grandchild.request('item', { config: { b: 9 }, label: 'request' });
  assert.deepEqual(override.context().options.config, { b: 9 });
  assert.equal(override.inherited(), 'request');
  assert.equal(grandchild.request('item').inherited(), 'child');
});

for (const baseUrl of [url, 'https://example.com/root']) {
  for (const input of ['item?q=one%20two#section', '../item', '?q=1', '#fragment',
    'https://other.example/path?q=2#hash', new URL('https://other.example/url?q=3#hash')]) {
    test(`URL resolution matches native URL: ${baseUrl} + ${input}`, () => {
      const operation = Dixous.create({ baseUrl, extensions: [inspect] }).request(input);
      assert.equal(operation.context().input, input);
      assert.equal(operation.context().request.url, new Request(new URL(input, baseUrl)).url);
    });
  }
}

test('Request input keeps its URL and effective native properties', () => {
  const input = new Request('https://other.example/existing?q=1#fragment', {
    method: 'POST', body: 'body', headers: { 'x-input': 'yes' },
  });
  const context = Dixous.create({ baseUrl: url, extensions: [inspect] }).request(input).context();
  assert.equal(context.input, input);
  assert.equal(context.request.url, input.url);
  assert.equal(context.request.method, 'POST');
  assert.equal(context.request.headers.get('x-input'), 'yes');
});

const headerForms = [
  entries => Object.fromEntries(entries),
  entries => entries,
  entries => new Headers(entries),
];
for (const [parentIndex, parentForm] of headerForms.entries()) {
  for (const [childIndex, childForm] of headerForms.entries()) {
    test(`headers merge by case-insensitive name across representations ${parentIndex}/${childIndex}`, () => {
      const parent = Dixous.create({ extensions: [inspect],
        headers: parentForm([['X-Shared', 'parent'], ['X-Parent', 'retained']]),
      });
      const child = parent.create({ headers: childForm([['x-shared', 'child'], ['X-Child', 'retained']]) }).create().create();
      assert.equal(child.request(url).context().request.headers.get('X-SHARED'), 'child');
      for (const requestForm of headerForms) {
        const context = child.request(url, { headers: requestForm([['X-SHARED', 'request']]) }).context();
        assert.deepEqual([...context.request.headers], [
          ['x-child', 'retained'], ['x-parent', 'retained'], ['x-shared', 'request'],
        ]);
      }
      assert.deepEqual([...parent.request(url).context().request.headers], [
        ['x-parent', 'retained'], ['x-shared', 'parent'],
      ]);
    });
  }
}

test('factories and middleware share independent per-operation contexts and stable option snapshots', async () => {
  const states = new WeakMap();
  const contexts = [];
  const replacement = new Request(`${url}replacement`, { headers: { 'x-mode': 'replacement' } });
  let middlewareCalls = 0;
  const client = Dixous.create({ baseUrl: url, headers: { 'x-mode': 'client' },
    label: 'client', extensions: [inspect, defineExtension({
      operation(context) {
        assert.ok(context.request instanceof Request);
        states.set(context, { original: context.request });
        contexts.push(context);
        return { currentRequest: () => context.request };
      },
      async request(context, next) {
        middlewareCalls++;
        assert.ok(states.has(context));
        assert.equal(context.request, states.get(context).original);
        context.request = replacement;
        return next();
      },
    }), defineExtension({ async request(context, next) {
      assert.ok(states.has(context));
      assert.equal(context.request, replacement);
      return next();
    } })], fetch: async request => {
      assert.equal(request, replacement);
      return new Response();
    },
  });
  const options = { label: 'request', headers: { 'x-mode': 'request' }, cache: 'no-store' };
  const first = client.request('first', options);
  const second = client.request('second');
  assert.notEqual(first, second);
  assert.notEqual(first.context(), second.context());
  assert.notEqual(first.currentRequest(), second.currentRequest());
  assert.equal(middlewareCalls, 0);
  assert.equal(contexts.length, 2);
  const context = first.context();
  const snapshot = context.options;
  assert.equal(context.request.cache, 'no-store');
  options.label = 'changed';
  context.request.headers.set('x-mode', 'changed');
  assert.equal(snapshot.headers.get('x-mode'), 'request');
  await first.response();
  assert.equal(context.input, 'first');
  assert.equal(context.options, snapshot);
  assert.equal(snapshot.label, 'request');
  assert.equal(snapshot.cache, 'no-store');
  assert.equal(snapshot.headers.get('x-mode'), 'request');
  assert.equal(first.currentRequest(), replacement);
  assert.equal(second.currentRequest().url, `${url}second`);
  await second.response();
  assert.equal(middlewareCalls, 2);
});

for (const order of [['status', 'response'], ['response', 'status'], ['status', 'other']]) {
  test(`operation methods share execution in order: ${order.join(' then ')}`, async () => {
    let calls = 0;
    let middlewareCalls = 0;
    const response = new Response('body');
    const client = Dixous.create({ fetch: async () => { calls++; return response; },
      extensions: [defineExtension({
        async request(context, next) { middlewareCalls++; return next(); },
        operation(context) { return {
          async status() {
            const [first, second] = await Promise.all([context.response(), context.response()]);
            assert.equal(first, second);
            return first.status;
          },
          other: () => context.response(),
        }; },
      })],
    });
    const operation = client.request(url);
    assert.equal(calls, 0);
    await Promise.all(order.map(method => operation[method]()));
    assert.equal(await operation.response(), response);
    assert.equal(calls, 1);
    assert.equal(middlewareCalls, 1);
    await client.request(url).response();
    assert.equal(calls, 2);
  });
}

test('the final native response preserves identity, metadata and its original stream', async () => {
  // Native fetch supplies URL metadata that Response constructors cannot set.
  const native = await fetch('data:text/plain,native%20body');
  const body = native.body;
  const operation = Dixous.create({ fetch: async () => native }).request(url);
  const response = await operation.response();
  assert.equal(response, native);
  assert.equal(response.url, 'data:text/plain,native%20body');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(response.body, body);
  assert.ok(body instanceof ReadableStream);
  assert.equal(response.bodyUsed, false);
  assert.equal(await operation.text(), 'native body');
  assert.equal(response.bodyUsed, true);
  await assert.rejects(operation.text(), TypeError);
  assert.equal(await operation.response(), native);
});

for (const status of [301, 304, 404, 500]) {
  for (const method of ['json', 'text', 'blob', 'arrayBuffer']) {
    test(`${method} follows Response.ok for ${status}, while response remains raw`, async () => {
      let calls = 0;
      const response = new Response(null, { status });
      const request = new Request(`${url}final`);
      const operation = Dixous.create({ fetch: async () => { calls++; return response; },
        extensions: [defineExtension({ async request(context, next) { context.request = request; return next(); } })],
      }).request(url);
      assert.equal(await operation.response(), response);
      await assert.rejects(operation[method](schema), error => {
        assert.ok(error instanceof UnexpectedResponseError);
        assert.equal(error.request, request);
        assert.equal(error.response, response);
        return true;
      });
      assert.equal(await operation.response(), response);
      assert.equal(calls, 1);
    });
  }
}

for (const firstMethod of ['json', 'text', 'blob', 'arrayBuffer']) {
  for (const secondMethod of ['json', 'text', 'blob', 'arrayBuffer']) {
    test(`${firstMethod} then ${secondMethod} retains native one-shot body semantics`, async () => {
      let calls = 0;
      const response = new Response('"body"');
      const operation = Dixous.create({ fetch: async () => { calls++; return response; } }).request(url);
      const value = await operation[firstMethod](schema);
      if (firstMethod === 'blob') assert.ok(value instanceof Blob);
      if (firstMethod === 'arrayBuffer') assert.ok(value instanceof ArrayBuffer);
      assert.equal(response.bodyUsed, true);
      await assert.rejects(operation[secondMethod](schema), TypeError);
      assert.equal(await operation.response(), response);
      assert.equal(calls, 1);
    });
  }
}

test('native abort and fetch failures propagate unchanged and are memoized', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const request of [new Request('data:text/plain,body', { signal: controller.signal }), new Request('unsupported-scheme://host')]) {
    let failure;
    let calls = 0;
    const operation = Dixous.create({ fetch: async input => {
      calls++;
      try { return await fetch(input); } catch (error) { failure = error; throw error; }
    } }).request(request);
    await assert.rejects(operation.response(), error => error === failure);
    assert.ok(failure instanceof Error);
    await assert.rejects(operation.response(), error => error === failure);
    await assert.rejects(operation.text(), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('middleware replacement travels upstream and short circuits all downstream work', async () => {
  const events = [];
  const cached = new Response('cached');
  const final = new Response('final');
  const parent = Dixous.create({ fetch: async () => { assert.fail('transport reached'); },
    extensions: [defineExtension({ async request(context, next) {
      events.push('outer before');
      assert.equal(await next(), cached);
      events.push('outer after');
      return final;
    } })],
  });
  const child = parent.create({ extensions: [
    defineExtension({ async request() { events.push('short circuit'); return cached; } }),
    defineExtension({ async request() { assert.fail('downstream reached'); } }),
  ] });
  assert.equal(await child.request(url).response(), final);
  assert.deepEqual(events, ['outer before', 'short circuit', 'outer after']);
});

test('sequential replay reruns only downstream layers and can explicitly clone before consumption', async () => {
  const events = [];
  const requests = [];
  const layer = name => defineExtension({ async request(context, next) {
    events.push(`${name} before`);
    const response = await next();
    events.push(`${name} after`);
    return response;
  } });
  const client = Dixous.create({ extensions: [layer('outer'), defineExtension({ async request(context, next) {
    events.push('retry');
    const replay = context.request.clone();
    await next();
    context.request = replay;
    return next();
  } }), layer('inner')], fetch: async request => {
    events.push('transport');
    requests.push(request);
    assert.equal(await request.text(), 'replayable');
    return new Response();
  } });
  await client.request(url, { method: 'POST', body: 'replayable' }).response();
  assert.notEqual(requests[0], requests[1]);
  assert.deepEqual(events, ['outer before', 'retry', 'inner before', 'transport', 'inner after',
    'inner before', 'transport', 'inner after', 'outer after']);
});

for (const where of ['before', 'after', 'downstream', 'transport']) {
  test(`arbitrary ${where} errors propagate unchanged and do not trigger automatic retries`, async () => {
    const error = { custom: 'extension failure' };
    let attempts = 0;
    const operation = Dixous.create({ extensions: [defineExtension({ async request(context, next) {
      attempts++;
      if (where === 'before') throw error;
      const response = await next();
      if (where === 'after') throw error;
      return response;
    } }), defineExtension({ async request(context, next) {
      if (where === 'downstream') throw error;
      return next();
    } })], fetch: () => {
      if (where === 'transport') throw error;
      return Promise.resolve(new Response());
    } }).request(url);
    await assert.rejects(operation.response(), value => value === error);
    await assert.rejects(operation.response(), value => value === error);
    assert.equal(attempts, 1);
  });
}

test('middleware can recover from a downstream exception with a native response', async () => {
  const error = new Error('downstream');
  const recovered = new Response('recovered');
  const operation = Dixous.create({ extensions: [defineExtension({ async request(context, next) {
    try { return await next(); } catch (caught) { assert.equal(caught, error); return recovered; }
  } }), defineExtension({ async request() { throw error; } })],
    fetch: async () => { assert.fail('transport reached'); },
  }).request(url);
  assert.equal(await operation.response(), recovered);
});

test('operation overrides follow installation order through derivation and preserve unrelated defaults', async () => {
  const error = new Error('custom method');
  const first = defineExtension({ operation: () => ({ json: () => 'first', custom: () => 1 }) });
  const last = defineExtension({ operation: () => ({ json: () => 'last', custom: () => 2 }) });
  const parent = Dixous.create({ extensions: [first, last], fetch: async () => new Response('native') });
  const child = parent.create({ extensions: [defineExtension({ operation: () => ({ custom: () => 3 }) })] });
  assert.equal(parent.request(url).custom(), 2);
  const operation = child.create().request(url);
  assert.equal(operation.json(), 'last');
  assert.equal(operation.custom(), 3);
  assert.equal(await operation.text(), 'native');
  const custom = child.create({ extensions: [defineExtension({ operation: () => ({
    json: () => 'child', text: () => 42, blob: () => null, arrayBuffer: () => false,
    arbitrary: () => ({ value: 1 }),
    promiseLike: () => ({ then: resolve => resolve('thenable value') }),
    fail: () => { throw error; },
  }) })] }).request(url);
  assert.equal(custom.json(), 'child');
  assert.equal(custom.text(), 42);
  assert.deepEqual(custom.arbitrary(), { value: 1 });
  assert.equal(await custom.promiseLike(), 'thenable value');
  assert.throws(custom.fail, value => value === error);
  assert.ok(await custom.response() instanceof Response);
});

test('extension methods are instantiated independently per operation', () => {
  const client = Dixous.create({ extensions: [defineExtension({ operation() {
    let count = 0;
    return { increment: () => ++count };
  } })] });
  const first = client.request(url);
  const second = client.request(url);
  assert.equal(first.increment(), 1);
  assert.equal(first.increment(), 2);
  assert.equal(second.increment(), 1);
});

for (const contribution of [
  { response: () => new Response() },
  Object.create({ response: () => new Response() }),
  Object.defineProperty({}, 'response', { value: undefined }),
]) {
  test('reserved response rejects runtime contributions, including inherited and non-enumerable properties', () => {
    const client = Dixous.create({ extensions: [{ operation: () => contribution }] });
    assert.throws(() => client.request(url), TypeError);
  });
}

test('consumers import a configured client and specialize it without affecting other consumers', async () => {
  const { client: shared } = await import('./fixtures/shared-client.mjs');
  const { client: otherConsumer } = await import('./fixtures/shared-client.mjs');
  assert.equal(shared, otherConsumer);
  const specialized = shared.create({ baseUrl: 'https://special.example/',
    headers: { authorization: 'special' }, label: 'special',
    extensions: [defineExtension({ operation: () => ({ extra: () => true }) })],
  });
  const operation = specialized.request('item');
  assert.equal(operation.label(), 'special');
  assert.equal(operation.extra(), true);
  assert.deepEqual(await operation.json(schema), {
    url: 'https://special.example/item', headers: [['authorization', 'special'], ['x-label', 'special']],
  });
  assert.deepEqual(await otherConsumer.request('item').json(schema), {
    url: 'https://shared.example/api/item', headers: [['authorization', 'shared'], ['x-label', 'shared']],
  });
});
