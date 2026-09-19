import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
mkdirSync(join(root, 'dist'), { recursive: true });
run('npm', ['pack', '--pack-destination', 'dist'], root);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const archive = join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`);
const consumer = mkdtempSync(join(tmpdir(), 'dixous-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer);
  const types = readFileSync(join(root, 'test/types.test.ts'), 'utf8').replace('../src/index.js', 'dixous');
  writeFileSync(join(consumer, 'types.test.ts'), types);
  run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.test.ts'], consumer);
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createDixous, defineExtension, HttpError, SchemaValidationError } from 'dixous';
const client = createDixous({ fetch: async () => new Response('packed package') });
assert.equal(await client.fetch('https://example.com').text(), 'packed package');
assert.equal(typeof defineExtension, 'function');
assert.ok(HttpError.prototype instanceof Error);
assert.ok(SchemaValidationError.prototype instanceof Error);
`);
  run('node', ['smoke.mjs'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/dixous/package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  console.log(`Consumer checks passed: ${archive}`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
