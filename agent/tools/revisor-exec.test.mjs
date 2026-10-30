import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const recorder = resolve(import.meta.dirname, 'revisor-exec.mjs');

/** An agent root (where Forge runs commands from) and a separate folder under test. */
function setup(t, secrets = '') {
  const root = mkdtempSync(join(tmpdir(), 'revisor-exec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge/test-secrets.env'), secrets);
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'hello.txt'), 'hello from the project\n');
  const run = (args, opts = {}) => spawnSync(process.execPath, [recorder, ...args], { cwd: root, encoding: 'utf8', timeout: 20000, ...opts });
  return { root, target, run };
}

test('records a command run in the working folder: output, exit code and a receipt file', t => {
  const { root, target, run } = setup(t);
  const result = run(['data/receipts/r1', 'scenario-01-cat', target, 'cat hello.txt; echo oops >&2; exit 3']);
  assert.equal(result.status, 0, 'the recorder succeeded even though the command failed');
  assert.match(result.stdout, /^exit 3 in [\d.]+s; receipt: data\/receipts\/r1\/scenario-01-cat\.txt/);
  assert.match(result.stdout, /hello from the project/);
  assert.match(result.stdout, /oops/);
  const receipt = readFileSync(join(root, 'data/receipts/r1/scenario-01-cat.txt'), 'utf8');
  assert.match(receipt, /^\$ cat hello\.txt; echo oops >&2; exit 3\n/);
  assert.match(receipt, new RegExp(`workdir: ${target}`));
  assert.match(receipt, /exit: 3/);
  assert.match(receipt, /--- stdout ---\nhello from the project/);
  assert.match(receipt, /--- stderr ---\noops/);
});

test('secrets reach the command by name and are redacted from output and receipts', t => {
  const { root, target, run } = setup(t, 'API_TOKEN=s3cret-value-123\n# comment\nOTHER="quoted value"\n');
  const result = run(['data/receipts/r2', 'scenario-01-env', target, 'echo token=$API_TOKEN; echo other=$OTHER; cat ../.forge/test-secrets.env']);
  assert.doesNotMatch(result.stdout, /s3cret-value-123|quoted value/);
  assert.match(result.stdout, /token=\[secret:API_TOKEN\]/);
  assert.match(result.stdout, /other=\[secret:OTHER\]/);
  const receipt = readFileSync(join(root, 'data/receipts/r2/scenario-01-env.txt'), 'utf8');
  assert.doesNotMatch(receipt, /s3cret-value-123|quoted value/);
});

test('a command that waits for input gets none, and a hung command is stopped', t => {
  const { target, run } = setup(t);
  const read = run(['data/receipts/r3', 'scenario-01-read', target, 'read line; echo got:$line']);
  assert.match(read.stdout, /^exit 0/);
  assert.match(read.stdout, /got:\n/, 'stdin is empty, so nothing blocks');
  const hung = run(['data/receipts/r3', 'scenario-02-hang', target, 'sleep 30'], { env: { ...process.env, REVISOR_COMMAND_TIMEOUT_S: '1' } });
  assert.match(hung.stdout, /^timed out after 1s/);
});

test('input can be given from a file', t => {
  const { root, target, run } = setup(t);
  writeFileSync(join(root, 'input.txt'), 'yes\n');
  const result = run(['data/receipts/r4', 'scenario-01-confirm', target, 'read answer; echo answered:$answer', join(root, 'input.txt')]);
  assert.match(result.stdout, /answered:yes/);
});

test('receipts stay inside data/receipts, names are plain, and the working folder must exist', t => {
  const { root, target, run } = setup(t);
  for (const args of [['../outside', 'x', target, 'true'], ['data/receipts/r5', '../escape', target, 'true'], ['data/receipts/r5', 'x', join(target, 'missing'), 'true']]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(existsSync(join(root, 'outside')), false);
  }
});
