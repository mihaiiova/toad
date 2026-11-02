import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const recorder = resolve(import.meta.dirname, 'toad-exec.mjs');
function setup(t, secrets = '') {
  const root = mkdtempSync(join(tmpdir(), 'toad-exec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge/test-secrets.env'), secrets);
  const target = join(root, 'target'); mkdirSync(target);
  writeFileSync(join(target, 'hello.txt'), 'hello from project\n');
  const run = (args, opts = {}) => spawnSync(process.execPath, [recorder, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, ...opts });
  const prepare = () => {
    const result = run(['prepare', target]);
    assert.equal(result.status, 0, result.stderr);
    return /Scenario ID: (.+)/.exec(result.stdout)[1];
  };
  return { root, target, run, prepare };
}

test('PASS and FAIL commands share persistent isolated workspace and receipts', t => {
  const { root, target, run, prepare } = setup(t);
  const id = prepare();
  const pass = run(['run', 'data/receipts/r1', 'scenario-01', id, 'cat hello.txt; echo changed > saved']);
  assert.equal(pass.status, 0, pass.stderr); assert.match(pass.stdout, /exit 0/); assert.match(pass.stdout, /hello from project/);
  const failure = run(['run', 'data/receipts/r1', 'scenario-02', id, 'cat saved; exit 3']);
  assert.equal(failure.status, 0); assert.match(failure.stdout, /exit 3/); assert.match(failure.stdout, /changed/);
  assert.equal(existsSync(join(target, 'saved')), false);
  assert.equal(readFileSync(join(root, '.forge/scenarios', id, 'project/saved'), 'utf8'), 'changed\n');
  assert.match(readFileSync(join(root, 'data/receipts/r1/scenario-02.txt'), 'utf8'), /result: exit 3/);
});

test('copy excludes secrets, receipts and symlinks without following them', t => {
  const { root, target, prepare } = setup(t);
  writeFileSync(join(target, '.env'), 'PASSWORD=private\n');
  writeFileSync(join(target, '.env.local'), 'secret');
  writeFileSync(join(target, '.env.example'), '# name only');
  mkdirSync(join(target, '.toad')); writeFileSync(join(target, '.toad', 'credentials'), 'private');
  mkdirSync(join(target, '.ssh')); writeFileSync(join(target, '.ssh', 'id_rsa'), 'private');
  writeFileSync(join(target, 'server.key'), 'private');
  mkdirSync(join(target, 'receipts')); writeFileSync(join(target, 'receipts', 'secret'), 'private');
  symlinkSync(join(root, '.forge'), join(target, 'external'));
  const project = join(root, '.forge/scenarios', prepare(), 'project');
  for (const name of ['.env', '.env.local', '.toad', '.ssh', 'server.key', 'receipts', 'external']) assert.equal(existsSync(join(project, name)), false, name);
  assert.equal(existsSync(join(project, '.env.example')), true);
});

test('project CLI credentials are selected, redacted even when short, and never fall back to shared secrets', t => {
  const { root, run, prepare } = setup(t, 'SHARED=shared-private\n');
  const id = prepare();
  const file = join(root, 'selected.json');
  writeFileSync(file, JSON.stringify({ TOKEN: 'xy', SELECTED: 'selected-private' }), { mode: 0o600 });
  const env = { ...process.env, TOAD_CLI_SECRETS_FILE: file };
  const result = run(['run', 'data/receipts/r2', 'project', id, 'printf "%s %s %s" "$TOKEN" "$SELECTED" "${SHARED-unset}"'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[secret:TOKEN\]/);
  assert.match(result.stdout, /\[secret:SELECTED\]/);
  assert.match(result.stdout, /unset/);
  const receipt = readFileSync(join(root, 'data/receipts/r2/project.txt'), 'utf8');
  for (const text of [result.stdout, receipt]) for (const value of ['xy', 'selected-private', 'shared-private']) assert.ok(!text.includes(value), value);
  writeFileSync(file, '{}');
  const empty = run(['run', 'data/receipts/r2', 'empty', id, 'printf "%s" "${SHARED-unset}"'], { env });
  assert.match(empty.stdout, /unset/);
});

test('project credential files fail closed on missing, malformed, symlinked or reserved values', t => {
  const { root, run, prepare } = setup(t, 'SHARED=shared-private\n');
  const id = prepare();
  const file = join(root, 'selected.json');
  const env = { ...process.env, TOAD_CLI_SECRETS_FILE: file };
  const exec = () => run(['run', 'data/receipts/r2', 'invalid', id, 'echo should-not-run'], { env });
  assert.equal(exec().status, 2);
  writeFileSync(file, 'not-json'); assert.equal(exec().status, 2);
  writeFileSync(file, '{"NODE_OPTIONS":"bad"}'); assert.match(exec().stderr, /reserved/);
  rmSync(file); symlinkSync(join(root, '.forge/test-secrets.env'), file); assert.equal(exec().status, 2);
  assert.equal(existsSync(join(root, 'data/receipts/r2/invalid.txt')), false);
});

test('secrets are redacted and command input and timeout are supported', t => {
  const { root, run, prepare } = setup(t, 'API_TOKEN=s3cret-value-123\n'); const id = prepare();
  const secret = run(['run', 'data/receipts/r2', 'secret', id, 'echo $API_TOKEN']);
  assert.match(secret.stdout, /\[secret:API_TOKEN\]/); assert.doesNotMatch(secret.stdout, /s3cret-value-123/);
  assert.doesNotMatch(readFileSync(join(root, 'data/receipts/r2/secret.txt'), 'utf8'), /s3cret-value-123/);
  writeFileSync(join(root, 'input.txt'), 'yes\n');
  assert.match(run(['run', 'data/receipts/r2', 'input', id, 'read a; echo $a', join(root, 'input.txt')]).stdout, /yes/);
  assert.match(run(['run', 'data/receipts/r2', 'timeout', id, 'sleep 30'], { env: { ...process.env, TOAD_COMMAND_TIMEOUT_S: '1' } }).stdout, /timed out after 1s/);
});

test('scenarios use different workspaces', t => {
  const { root, run, prepare } = setup(t); const a = prepare(), b = prepare(); assert.notEqual(a, b);
  run(['run', 'data/receipts/r3', 'write', a, 'echo first > one']);
  const read = run(['run', 'data/receipts/r3', 'read', b, 'test ! -e one']);
  assert.match(read.stdout, /exit 0/); assert.ok(readdirSync(join(root, '.forge/scenarios')).includes(a));
});

test('concurrent preparation creates distinct isolated workspaces', async t => {
  const { root, target } = setup(t);
  const prepare = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recorder, 'prepare', target], { cwd: root });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(/Scenario ID: (.+)/.exec(out)[1]) : reject(new Error(err)));
  });
  const ids = await Promise.all([prepare(), prepare(), prepare()]);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.equal(readFileSync(join(root, '.forge/scenarios', id, 'project/hello.txt'), 'utf8'), 'hello from project\n');
});

test('ERROR invalid ID and preflight failure never execute a host command', t => {
  const { root, target, run } = setup(t);
  const marker = join(root, 'host-marker');
  const bad = run(['run', 'data/receipts/r4', 'bad', '../escape', `touch ${marker}`]);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /infrastructure error/); assert.equal(existsSync(marker), false);
  const bin = join(root, 'fakebin'); mkdirSync(bin); writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\necho unavailable >&2\nexit 1\n', { mode: 0o755 });
  const failed = run(['prepare', target], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(failed.status, 2); assert.match(failed.stderr, /infrastructure error/); assert.equal(existsSync(marker), false);
});
