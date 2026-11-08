import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chooseSandbox } from '../../agent/tools/toad-sandbox.mjs';
import { MAX_STEP_CHARS, replayCliPayload } from '../../agent/tools/toad-cli-recording.mjs';
import { finalizeCliCandidates, receiptProvesPass, recordingStatus, scenarioId } from '../recordings.mjs';

const tmpdir = () => realpathSync(osTmpdir());
const runner = resolve(import.meta.dirname, '../../agent/tools/toad-exec.mjs');
const structured = resolve(import.meta.dirname, '../../agent/tools/toad-structured-cli.mjs');
const scenario = { name: 'Check version', steps: 'Run ./check and look at its output.', expected: 'It prints ready and exits 0.' };
const slug = 'check-version';

let sandboxAvailable = true;
try { chooseSandbox(); } catch { sandboxAvailable = false; }

/** A project whose ./check prints `ready`, plus a run folder to record into. */
function fixture(t, { capture = { scenarioName: scenario.name, complete: true }, recording = true, script = 'printf "ready\\n"\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'toad-cli-recording-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'check'), `#!/bin/sh\n${script}`);
  chmodSync(join(project, 'check'), 0o755);
  const run = join(root, 'run');
  const receipts = join(run, 'receipts');
  mkdirSync(join(receipts, slug), { recursive: true });
  const env = {
    ...process.env, TOAD_CLI_SANDBOX: process.env.TOAD_CLI_SANDBOX || 'auto',
    TOAD_CLI_IMAGE: process.env.TOAD_TEST_IMAGE || 'node:22-slim',
    TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_RECEIPTS_DIR: receipts,
  };
  for (const name of ['TOAD_CLI_SECRETS_FILE', 'TOAD_EXEC_JSON', 'TOAD_CLI_PATH', 'TOAD_RECORDING_ENABLED']) delete env[name];
  if (recording) env.TOAD_RECORDING_ENABLED = 'cli-v1';
  const prepared = spawnSync(process.execPath, [runner, 'prepare', project], { encoding: 'utf8', env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const scenarioIdValue = /Scenario ID: (.+)/.exec(prepared.stdout)[1];
  const request = { scenario: scenarioIdValue, receipts: join(receipts, slug), name: '01-check', program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } }, ...(capture ? { capture } : {}) };
  const requestFile = join(root, 'request.json');
  writeFileSync(requestFile, JSON.stringify(request));
  const result = spawnSync(process.execPath, [structured, requestFile], { encoding: 'utf8', env, timeout: 120000 });
  return { root, project, run, receipts, env, result, scenarioId: scenarioIdValue, requestFile, request };
}

function persist(run, overrides = {}) {
  const handoff = { version: 1, kind: 'cli', target: { workdir: '/project' }, request: { goal: 'Check the version', scenarios: [scenario] }, ...overrides };
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(handoff));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: scenario.name, result: 'PASS' }] }));
  return handoff;
}

test('a captured structured command finalizes into a recording that replays deterministically', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { project, run, receipts, env, result } = fixture(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).captured, true);

  const handoff = persist(run);
  finalizeCliCandidates(run, handoff, [{ name: scenario.name, result: 'PASS' }]);
  const status = recordingStatus(run, 'cli', scenario);
  assert.equal(status.status, 'recorded');
  assert.deepEqual(status.steps, [{ action: './check', assertion: 'exit 0; stdout {"equals":"ready\\n"}' }]);

  // The finalized payload alone reproduces the verdict, without a model.
  const envelope = JSON.parse(readFileSync(join(run, 'recording', `${scenarioId(scenario.name)}.json`), 'utf8'));
  const replayReceipts = join(run, 'replay-receipts');
  const replayEnv = { ...env, TOAD_RECEIPTS_DIR: replayReceipts };
  assert.equal(replayCliPayload(envelope.payload, { project, receipts: replayReceipts, env: replayEnv }).result, 'PASS');

  // A regression in the program fails the recording's own assertion.
  writeFileSync(join(project, 'check'), '#!/bin/sh\nprintf "broken\\n"\n');
  chmodSync(join(project, 'check'), 0o755);
  const regression = replayCliPayload(envelope.payload, { project, receipts: replayReceipts, env: replayEnv });
  assert.equal(regression.result, 'FAIL');
  assert.deepEqual(regression.checks, { exitCode: true, stdout: false });
  assert.match(readFileSync(join(receipts, slug, '01-check.txt'), 'utf8'), /result: exit 0/);
});

test('a candidate is discarded unless its own receipt proves the same command, exit and stdout', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { root, run, receipts } = fixture(t);
  const receiptPath = join(receipts, slug, '01-check.txt');
  const original = readFileSync(receiptPath, 'utf8');
  const payload = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };
  assert.equal(receiptProvesPass(original, payload), true);
  assert.equal(receiptProvesPass(original, { ...payload, args: ['--flag'] }), false);
  assert.equal(receiptProvesPass(original, { ...payload, expect: { exitCode: 1, stdout: { equals: 'ready\n' } } }), false);
  assert.equal(receiptProvesPass(original, { ...payload, expect: { exitCode: 0, stdout: { equals: 'broken\n' } } }), false);

  const handoff = persist(run);
  const copy = name => { const other = join(root, name); cpSync(run, other, { recursive: true }); return other; };
  const tampered = [
    original.replace(/^\$ .*$/m, '$ exec other'),
    original.replace('\nresult: exit 0\n', '\nresult: exit 3\n'),
    original.replace('--- stdout ---\nready\n', '--- stdout ---\nbroken\n'),
    original.replace('\n--- stderr ---\n', '\n--- stdout ---\n\n--- stderr ---\n'),
    original.replace('\nduration:', '\noutput: truncated (2 MiB per stream limit)\nduration:'),
  ];
  tampered.forEach((text, i) => {
    const dir = copy(`tampered-${i}`);
    writeFileSync(join(dir, 'receipts', slug, '01-check.txt'), text);
    finalizeCliCandidates(dir, handoff, [{ name: scenario.name, result: 'PASS' }]);
    assert.deepEqual(recordingStatus(dir, 'cli', scenario), { status: 'not-captured' }, `tampered receipt ${i}`);
  });
});

test('a capture that exceeds the recording bounds is not written and does not fail the test', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { receipts, env, scenarioId: id, requestFile } = fixture(t);
  const long = {
    scenario: id, receipts: join(receipts, slug), name: '02-long', program: './check', args: ['x'.repeat(MAX_STEP_CHARS)],
    expect: { exitCode: 0, stdout: { equals: 'ready\n' } }, capture: { scenarioName: scenario.name, complete: true },
  };
  writeFileSync(requestFile, JSON.stringify(long));
  const result = spawnSync(process.execPath, [structured, requestFile], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.status, 'pass');
  assert.equal(answer.captured, false);
  assert.equal(existsSync(`${answer.receipt}.recording.json`), false);
});

test('no recording is finalized for a failed scenario, another receipt, or a credential-bearing handoff', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { root, run } = fixture(t);
  const base = persist(run);
  const copy = name => { const other = join(root, name); cpSync(run, other, { recursive: true }); return other; };

  // The persisted run did not PASS the scenario.
  const failed = copy('failed');
  writeFileSync(join(failed, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: scenario.name, result: 'FAIL' }] }));
  finalizeCliCandidates(failed, base, [{ name: scenario.name, result: 'FAIL' }]);
  assert.deepEqual(recordingStatus(failed, 'cli', scenario), { status: 'not-captured' });

  // A handoff that selects credentials is never recordable.
  const credentialed = copy('credentialed');
  const withCredentials = { ...base, credentials: { token: { env: 'TOKEN' } } };
  writeFileSync(join(credentialed, 'handoff.yaml'), JSON.stringify(withCredentials));
  finalizeCliCandidates(credentialed, withCredentials, [{ name: scenario.name, result: 'PASS' }]);
  assert.deepEqual(recordingStatus(credentialed, 'cli', scenario), { status: 'not-captured' });

  // An extra receipt in the scenario folder makes the capture ambiguous.
  const extra = copy('extra');
  writeFileSync(join(extra, 'receipts', slug, '02-debug.txt'), '$ something\nresult: exit 0\n');
  finalizeCliCandidates(extra, base, [{ name: scenario.name, result: 'PASS' }]);
  assert.deepEqual(recordingStatus(extra, 'cli', scenario), { status: 'not-captured' });
});

test('capture is off without a recording-enabled run, and requires the attested form', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const off = fixture(t, { recording: false });
  assert.equal(off.result.status, 0, off.result.stderr + off.result.stdout);
  assert.equal(JSON.parse(off.result.stdout).captured, false);
  persist(off.run);
  finalizeCliCandidates(off.run, JSON.parse(readFileSync(join(off.run, 'handoff.yaml'), 'utf8')), [{ name: scenario.name, result: 'PASS' }]);
  assert.deepEqual(recordingStatus(off.run, 'cli', scenario), { status: 'not-captured' });

  const incomplete = fixture(t, { capture: { scenarioName: scenario.name, complete: false } });
  assert.equal(incomplete.result.status, 2);
  assert.equal(JSON.parse(incomplete.result.stdout).error, 'invalid structured CLI request');

  const wrongName = fixture(t, { capture: { scenarioName: 'Other scenario', complete: true } });
  assert.equal(JSON.parse(wrongName.result.stdout).captured, true);
  persist(wrongName.run);
  finalizeCliCandidates(wrongName.run, JSON.parse(readFileSync(join(wrongName.run, 'handoff.yaml'), 'utf8')), [{ name: scenario.name, result: 'PASS' }]);
  assert.deepEqual(recordingStatus(wrongName.run, 'cli', scenario), { status: 'not-captured' });
});

test('a captured command must actually pass to be recorded', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, t => {
  const { run, result } = fixture(t, { script: 'printf "ready\\n"; exit 3\n' });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).captured, false);
  const handoff = persist(run);
  finalizeCliCandidates(run, handoff, [{ name: scenario.name, result: 'PASS' }]);
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
  assert.equal(existsSync(join(run, 'recording')), false);
});
