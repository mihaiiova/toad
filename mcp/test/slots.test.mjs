import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
// Project paths must be canonical; on macOS the temp folder is behind a symlink.
const tmpdir = () => realpathSync(osTmpdir());
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireSlot, slotLimit } from '../slots.mjs';

function slots(t) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'slots');
}

test('slots are limited, released, and reusable', async t => {
  const dir = slots(t);
  const a = await acquireSlot({ dir, limit: 2 }), b = await acquireSlot({ dir, limit: 2 });
  let waited = 0;
  const controller = new AbortController();
  const third = acquireSlot({ dir, limit: 2, pollMs: 10, signal: controller.signal, onWait: () => { waited++; } });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(waited > 0, 'a third run waits');
  a();
  const c = await third;
  assert.equal(typeof c, 'function');
  b(); c();
  assert.equal(existsSync(join(dir, 'slot-0')) || existsSync(join(dir, 'slot-1')), false);
});

test('a slot held by a dead process is taken over; a live one is not', async t => {
  const dir = slots(t);
  await acquireSlot({ dir, limit: 1 }).then(release => release());
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(join(dir, 'slot-0'), `${dead}:stale`);
  const release = await acquireSlot({ dir, limit: 1 });
  assert.notEqual(readFileSync(join(dir, 'slot-0'), 'utf8'), `${dead}:stale`);
  release();
  writeFileSync(join(dir, 'slot-0'), `${process.pid}:other-server`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  assert.equal(await acquireSlot({ dir, limit: 1, pollMs: 10, signal: controller.signal }), null);
  assert.equal(readFileSync(join(dir, 'slot-0'), 'utf8'), `${process.pid}:other-server`, 'releasing never removes another owner\'s slot');
});

test('the limit comes from TOAD_MAX_CONCURRENT_RUNS, defaulting to 2', () => {
  assert.equal(slotLimit({}), 2);
  assert.equal(slotLimit({ TOAD_MAX_CONCURRENT_RUNS: '4' }), 4);
  assert.equal(slotLimit({ TOAD_MAX_CONCURRENT_RUNS: '0' }), 2);
  assert.equal(slotLimit({ TOAD_MAX_CONCURRENT_RUNS: 'many' }), 2);
});
