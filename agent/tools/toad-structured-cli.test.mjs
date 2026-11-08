import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bwrapVersion, MIN_BWRAP, containerRuntime } from './toad-sandbox.mjs';

const tool = resolve(import.meta.dirname, 'toad-structured-cli.mjs');
const runner = resolve(import.meta.dirname, 'toad-exec.mjs');
const version = bwrapVersion();
const bwrap = version && version.some((v, i) => v !== MIN_BWRAP[i] && version.slice(0, i).every((n, j) => n === MIN_BWRAP[j]) && v > MIN_BWRAP[i]) || version?.every((v, i) => v === MIN_BWRAP[i]);
const backends = ['none', ...(bwrap ? ['bwrap'] : []), ...(containerRuntime() ? ['container'] : [])];

function fixture(t, backend) {
  const root = mkdtempSync(join(tmpdir(), 'toad-structured-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const receipts = join(root, 'receipts'); mkdirSync(receipts);
  const env = { ...process.env, TOAD_CLI_SANDBOX: backend, TOAD_CLI_IMAGE: process.env.TOAD_TEST_IMAGE || 'node:22-slim', TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_RECEIPTS_DIR: receipts };
  delete env.TOAD_CLI_SECRETS_FILE; delete env.TOAD_EXEC_JSON; delete env.TOAD_CLI_PATH;
  const prepared = spawnSync(process.execPath, [runner, 'prepare', project], { cwd: root, env, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const scenario = /Scenario ID: (.+)/.exec(prepared.stdout)[1];
  const run = (request, extra = {}) => spawnSync(process.execPath, [tool], { cwd: root, env: { ...env, ...extra }, input: JSON.stringify(request), encoding: 'utf8', timeout: 30000 });
  return { root, receipts, scenario, run };
}

for (const backend of backends) test(`structured CLI uses ${backend} scenario isolation and exact assertions`, t => {
  const { root, receipts, scenario, run } = fixture(t, backend);
  const marker = join(root, 'injected');
  const literal = `a'b;$(touch ${marker})\nnext`;
  const base = { receipts, scenario, name: 'assertion', program: 'printf', args: ['%s', literal], expect: { exitCode: 0, stdout: { equals: literal } } };
  const pass = run(base);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);
  const passed = JSON.parse(pass.stdout);
  assert.equal(passed.status, 'pass'); assert.equal(passed.actual.stdout, literal);
  assert.equal(existsSync(marker), false);
  assert.match(readFileSync(passed.receipt, 'utf8'), /result: exit 0/);
  const mismatch = run({ ...base, name: 'mismatch', expect: { exitCode: 1, stdout: { contains: 'missing' } } });
  assert.equal(mismatch.status, 1);
  assert.deepEqual(JSON.parse(mismatch.stdout).checks, { exitCode: false, stdout: false });
  const contains = run({ ...base, name: 'contains', expect: { exitCode: 0, stdout: { contains: 'next' } } });
  assert.equal(contains.status, 0, contains.stdout);
  const nonzero = run({ ...base, name: 'nonzero', program: 'sh', args: ['-c', 'printf expected; exit 7'], expect: { exitCode: 7, stdout: { equals: 'expected' } } });
  assert.equal(nonzero.status, 0, nonzero.stdout);
  assert.equal(JSON.parse(nonzero.stdout).actual.exitCode, 7);
});

test('invalid requests, credentials and runner errors are structured errors', t => {
  const { root, receipts, scenario, run } = fixture(t, 'none');
  const base = { receipts, scenario, name: 'test', program: 'printf', args: ['ok'], expect: { exitCode: 0, stdout: { equals: 'ok' } } };
  for (const request of [ { ...base, credentials: { token: 'secret' } }, { ...base, args: ['x\0y'] }, { ...base, expect: { exitCode: 0, stdout: { equals: 'ok', contains: 'ok' } } }, { ...base, expect: { exitCode: 0, stdout: { contains: '' } } } ]) {
    const result = run(request); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).status, 'error');
  }
  const secretFile = join(root, 'secret');
  const projectSecret = run(base, { TOAD_CLI_SECRETS_FILE: secretFile });
  assert.equal(projectSecret.status, 2); assert.match(JSON.parse(projectSecret.stdout).error, /credentials/);
  for (const content of ['{"TOKEN":"private"}', '[]', 'null', '{invalid']) {
    writeFileSync(secretFile, content);
    const result = run(base, { TOAD_CLI_SECRETS_FILE: secretFile });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /private/);
  }
  writeFileSync(secretFile, '{}');
  const link = join(root, 'secret-link'); symlinkSync(secretFile, link);
  assert.equal(run(base, { TOAD_CLI_SECRETS_FILE: link }).status, 2);
  mkdirSync(join(root, '.faur')); writeFileSync(join(root, '.faur', 'test-secrets.env'), 'TOKEN=value\n');
  assert.equal(run(base).status, 2);
  assert.equal(run(base, { TOAD_CLI_SECRETS_FILE: secretFile }).status, 0, 'an empty project selector never falls back to the legacy store');
  rmSync(join(root, '.faur'), { recursive: true });
  const invalidScenario = run({ ...base, scenario: 'invalid' });
  assert.equal(invalidScenario.status, 2); assert.equal(JSON.parse(invalidScenario.stdout).status, 'error');
  const timeout = run({ ...base, name: 'timeout', program: 'sleep', args: ['3'] }, { TOAD_COMMAND_TIMEOUT_S: '0.2' });
  assert.equal(timeout.status, 2); assert.equal(JSON.parse(timeout.stdout).status, 'error');
  assert.ok(existsSync(JSON.parse(timeout.stdout).receipt));
  const truncated = run({ ...base, name: 'large', program: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(3*1024*1024))'] });
  assert.equal(truncated.status, 2); assert.equal(JSON.parse(truncated.stdout).status, 'error');
});
