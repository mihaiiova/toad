import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateFits, cliAssertion, cliChecks, cliCommand, MAX_CANDIDATE_BYTES, MAX_STEP_CHARS, replayCliPayload, validCliPayload } from './toad-cli-recording.mjs';
import { bwrapVersion, chooseSandbox, containerRuntime, MIN_BWRAP } from './toad-sandbox.mjs';

const payload = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };

let sandboxAvailable = true;
try { chooseSandbox(); } catch { sandboxAvailable = false; }
function versionAtLeast(version, min) {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}
const version = bwrapVersion();
const backends = ['none', ...(version && versionAtLeast(version, MIN_BWRAP) ? ['bwrap'] : []), ...(containerRuntime() ? ['container'] : [])];

test('payload validation and command rendering are strict and shell-safe', () => {
  assert.equal(validCliPayload(payload), true);
  assert.equal(validCliPayload({ ...payload, program: '' }), false);
  assert.equal(validCliPayload({ ...payload, program: '-c' }), false);
  assert.equal(validCliPayload({ ...payload, args: ['a\0b'] }), false);
  assert.equal(validCliPayload({ ...payload, expect: { exitCode: 0, stdout: { equals: 'x', contains: 'x' } } }), false);
  assert.equal(validCliPayload({ ...payload, expect: { exitCode: 0, stdout: { contains: '' } } }), false);
  assert.equal(validCliPayload({ ...payload, expect: { exitCode: 256, stdout: { contains: 'x' } } }), false);
  // `exec` and every later word are quoted, so shell syntax stays literal.
  assert.equal(
    cliCommand({ program: 'printf', args: ['%s', `a'b;$(touch x)\nnext`, ''] }),
    `exec 'printf' '%s' 'a'\\''b;$(touch x)\nnext' ''`,
  );
  assert.deepEqual(cliChecks(payload, 0, 'ready\n'), { exitCode: true, stdout: true });
  assert.deepEqual(cliChecks(payload, 1, 'broken\n'), { exitCode: false, stdout: false });
  assert.deepEqual(cliChecks({ ...payload, expect: { exitCode: 0, stdout: { contains: 'ready' } } }, 0, 'not ready'), { exitCode: true, stdout: true });
  assert.equal(cliAssertion(payload), 'exit 0; stdout {"equals":"ready\\n"}');
});

test('candidate bounds cover the envelope, the scenario name and both displayed lines', () => {
  assert.equal(candidateFits(payload, 'Check version'), true);
  // The scenario name counts towards the stored candidate, not only the payload.
  assert.equal(candidateFits(payload, 'x'.repeat(MAX_CANDIDATE_BYTES - 100)), false);
  // A long expected stdout makes the assertion line too long to display.
  const longAssertion = { ...payload, expect: { exitCode: 0, stdout: { equals: 'x'.repeat(MAX_STEP_CHARS) } } };
  assert.ok(cliAssertion(longAssertion).length > MAX_STEP_CHARS);
  assert.equal(candidateFits(longAssertion, 'Check version'), false);
  // A long argument makes the displayed action too long.
  const longAction = { ...payload, args: ['x'.repeat(MAX_STEP_CHARS)] };
  assert.equal(candidateFits(longAction, 'Check version'), false);
});

test('replay needs a valid payload, a project and a receipts folder', () => {
  assert.throws(() => replayCliPayload({ ...payload, program: '' }, { project: '/tmp', receipts: '/tmp' }), /Invalid CLI recording payload/);
  assert.throws(() => replayCliPayload(payload, { project: '', receipts: '' }), /Replay needs/);
});

function fixture(t, backend) {
  const root = mkdtempSync(join(tmpdir(), 'toad-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const receipts = join(root, 'data/receipts');
  const env = {
    ...process.env, TOAD_CLI_SANDBOX: backend, TOAD_CLI_IMAGE: process.env.TOAD_TEST_IMAGE || 'node:22-slim',
    TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_RECEIPTS_DIR: receipts,
  };
  delete env.TOAD_CLI_SECRETS_FILE; delete env.TOAD_EXEC_JSON; delete env.TOAD_CLI_PATH; delete env.TOAD_RECORDING_ENABLED;
  const script = text => { writeFileSync(join(project, 'check'), `#!/bin/sh\n${text}`); chmodSync(join(project, 'check'), 0o755); };
  return { root, project, receipts, env, script };
}

for (const backend of backends) test(`replay of a recorded payload is deterministic with the ${backend} sandbox`, { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { project, receipts, env, script } = fixture(t, backend);
  script('printf "ready\\n"\n');
  const first = replayCliPayload(payload, { project, receipts, env });
  assert.equal(first.result, 'PASS', JSON.stringify(first));
  // The explicitly chosen sandbox is the one the replay used.
  const sandbox = backend === 'none' ? /sandbox: none/ : backend === 'bwrap' ? /sandbox: bubblewrap/ : /sandbox: (docker|podman)/;
  assert.match(readFileSync(first.receipt, 'utf8'), sandbox);
  assert.deepEqual(first.checks, { exitCode: true, stdout: true });
  assert.equal(first.actual.stdout, 'ready\n');
  // A second run reaches the same verdict from the recording alone.
  assert.equal(replayCliPayload(payload, { project, receipts, env }).result, 'PASS');

  // A changed program fails the recorded assertion: a regression, reported as FAIL.
  script('printf "broken\\n"\n');
  const regression = replayCliPayload(payload, { project, receipts, env });
  assert.equal(regression.result, 'FAIL');
  assert.deepEqual(regression.checks, { exitCode: true, stdout: false });
  assert.equal(regression.actual.stdout, 'broken\n');

  // An expected nonzero exit is its own assertion, not a failure.
  script('printf "expected\\n"; exit 7\n');
  const nonzero = { program: './check', args: [], expect: { exitCode: 7, stdout: { equals: 'expected\n' } } };
  assert.equal(replayCliPayload(nonzero, { project, receipts, env }).result, 'PASS');
  assert.equal(replayCliPayload({ ...nonzero, expect: { exitCode: 0, stdout: { equals: 'expected\n' } } }, { project, receipts, env }).result, 'FAIL');
});

test('replay ignores an inherited setup workspace, PATH addition and capture switch', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { project, receipts, env, script } = fixture(t, 'none');
  const runner = resolve(import.meta.dirname, 'toad-exec.mjs');
  script('printf "ready\\n"\n');
  mkdirSync(join(project, 'tools/bin'), { recursive: true });
  writeFileSync(join(project, 'tools/bin/ready-tool'), '#!/bin/sh\nprintf "ready\\n"\n');
  chmodSync(join(project, 'tools/bin/ready-tool'), 0o755);
  const prepared = spawnSync(process.execPath, [runner, 'prepare', project], { encoding: 'utf8', env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const base = /Scenario ID: (.+)/.exec(prepared.stdout)[1];
  // The project itself now fails, so a pass could only come from the stale base.
  script('printf "broken\\n"\n');
  const dirty = { ...env, TOAD_BASE_SCENARIO: base, TOAD_CLI_PATH: JSON.stringify(['tools/bin']), TOAD_RECORDING_ENABLED: 'cli-v1' };
  const replay = replayCliPayload(payload, { project, receipts, env: dirty });
  assert.equal(replay.result, 'FAIL');
  assert.equal(replay.actual.stdout, 'broken\n');
  // The PATH addition is not part of the recording either.
  const byPath = replayCliPayload({ program: 'ready-tool', args: [], expect: { exitCode: 0, stdout: { contains: 'ready' } } }, { project, receipts, env: dirty });
  assert.equal(byPath.result, 'FAIL');
  assert.equal(byPath.actual.exitCode, 127);
});

test('replay reports an infrastructure failure instead of a verdict', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { root, receipts, env } = fixture(t, 'none');
  assert.throws(() => replayCliPayload(payload, { project: join(root, 'missing'), receipts, env }), /could not prepare/);
});
