import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSecretReferences } from '../project-secrets.mjs';

function project(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (contents !== undefined) writeFileSync(join(dir, '.env'), contents);
  return dir;
}
const ref = { password: { env: 'PASSWORD' } };

test('resolve only explicitly named credentials', t => {
  const dir = project(t, 'PASSWORD="s3cr3t-sentinel"\nUNUSED=another-secret\n');
  assert.deepEqual({ ...resolveSecretReferences(dir, ref) }, { PASSWORD: 's3cr3t-sentinel' });
});

test('reject missing, empty, duplicate and malformed entries without exposing values', t => {
  for (const [contents, expected] of [
    ['UNUSED=s3cr3t-sentinel\n', /Missing/],
    ['PASSWORD=\n', /Empty/],
    ['PASSWORD=one\nPASSWORD=two\n', /Duplicate/],
    ['PASSWORD="s3cr3t-sentinel\n', /Malformed/],
    ['PASSWORD="foo\0bar"\n', /Malformed/],
    ['PASSWORD=ok\ninvalid\n', /Malformed/],
  ]) {
    const dir = project(t, contents);
    assert.throws(() => resolveSecretReferences(dir, ref), error => expected.test(error.message) && !error.message.includes('s3cr3t-sentinel'));
  }
  const dir = project(t, 'PASSWORD=ok\n');
  assert.throws(() => resolveSecretReferences(dir, { a: ref.password, b: ref.password }), /distinct/);
});

test('refuses symlinked credential stores', t => {
  const dir = project(t);
  writeFileSync(join(dir, 'other'), 'PASSWORD=secret\n');
  symlinkSync(join(dir, 'other'), join(dir, '.env'));
  assert.throws(() => resolveSecretReferences(dir, ref), /safely read/);
});
