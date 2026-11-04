import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathEntries, readProjectConfig, suiteSchema, withDefaults } from '../projects.mjs';
import { handoffSchema } from '../run.mjs';

test('workspace PATH is validated consistently and handoffs override defaults', t => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'toad.yaml'), 'cli:\n  path: [node_modules/.bin]\n');
  const config = readProjectConfig(dir);
  const handoff = { version: 1, kind: 'cli', request: { goal: 'test' } };
  assert.deepEqual(withDefaults(handoff, config, dir).target.path, ['node_modules/.bin']);
  assert.deepEqual(withDefaults({ ...handoff, target: { path: [] } }, config, dir).target.path, []);
  assert.equal(handoffSchema.safeParse({ ...handoff, target: { path: ['tools/bin'] } }).success, true);
  const suite = { kind: 'cli', goal: 'test', scenarios: [{ name: 'test', steps: 'run', expected: 'ok' }] };
  assert.equal(suiteSchema.safeParse({ ...suite, target: { path: ['tools/bin'] } }).success, true);
  for (const path of ['/bin', '../bin', 'tools/../bin', '.', 'bin:other', 'bin;echo', '']) {
    assert.equal(pathEntries.safeParse([path]).success, false, path);
    assert.equal(handoffSchema.safeParse({ ...handoff, target: { path: [path] } }).success, false, path);
    assert.equal(suiteSchema.safeParse({ ...suite, target: { path: [path] } }).success, false, path);
  }
});
