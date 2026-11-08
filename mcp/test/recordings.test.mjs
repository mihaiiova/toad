import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { finalizeRecording, intentHash, markNotRecordable, recordingStatus, scenarioId } from '../recordings.mjs';

const scenario = { name: 'Log in', steps: 'Run it', expected: 'It works' };
function runDir(t) {
  const run = mkdtempSync(join(tmpdir(), 'toad-recordings-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  return run;
}

// recordings.mjs imports ../agent/tools/, so a copied store keeps the same layout.
function copyStore(t) {
  const dir = runDir(t);
  mkdirSync(join(dir, 'agent/tools'), { recursive: true });
  mkdirSync(join(dir, 'mcp'));
  copyFileSync(resolve(import.meta.dirname, '../../agent/tools/toad-cli-recording.mjs'), join(dir, 'agent/tools/toad-cli-recording.mjs'));
  copyFileSync(resolve(import.meta.dirname, '../../agent/tools/toad-api-recording.mjs'), join(dir, 'agent/tools/toad-api-recording.mjs'));
  copyFileSync(resolve(import.meta.dirname, '../recordings.mjs'), join(dir, 'mcp/recordings.mjs'));
  return dir;
}

async function fixtureStore(t) {
  const dir = copyStore(t);
  // Test-only codec accepts a closed set of actions/assertions, no arbitrary
  // strings or credentials. It is never registered in the production module.
  writeFileSync(join(dir, 'mcp/recording-codecs.mjs'), `export const RECORDING_CODECS = Object.freeze({ 'fixture-v1': Object.freeze({
    validate(payload, context) {
      return !Object.keys(context.handoff.credentials ?? {}).length &&
        payload && Object.keys(payload).sort().join(',') === 'action,assertion' &&
        ['inspect','list'].includes(payload.action) && ['success','empty'].includes(payload.assertion);
    },
    describe(payload) { return [{ action: payload.action, assertion: payload.assertion }]; }
  }) });`);
  return import(`file://${join(dir, 'mcp/recordings.mjs')}`);
}

function completed(run, kind = 'cli', s = scenario, result = 'PASS') {
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({ kind, request: { scenarios: [s] } }));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: s.name, result }] }));
}

test('unknown codecs are refused and never finalize a recording', t => {
  const run = runDir(t);
  completed(run);
  assert.throws(() => finalizeRecording(run, 'cli', scenario, 'fixture-v1', { action: 'inspect', assertion: 'success' }), /Unsupported/);
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
});

test('the built-in CLI codec records only a credential-free, completed, matching PASS', t => {
  const payload = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };
  const run = runDir(t);
  completed(run);
  finalizeRecording(run, 'cli', scenario, 'cli-command-v1', payload);
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'recorded', steps: [{ action: './check', assertion: 'exit 0; stdout {"equals":"ready\\n"}' }] });
  // A payload the codec rejects never becomes a recording.
  const rejected = runDir(t); completed(rejected);
  assert.throws(() => finalizeRecording(rejected, 'cli', scenario, 'cli-command-v1', { ...payload, program: '-c' }), /Unsupported/);
  assert.deepEqual(recordingStatus(rejected, 'cli', scenario), { status: 'not-captured' });
  // A handoff with credentials, installs, setup or PATH is outside the codec.
  for (const extra of [{ credentials: { token: { env: 'TOKEN' } } }, { allow_installs: true }, { target: { setup: ['npm ci'] } }, { target: { path: ['node_modules/.bin'] } }]) {
    const blocked = runDir(t);
    writeFileSync(join(blocked, 'handoff.yaml'), JSON.stringify({ kind: 'cli', ...extra, request: { scenarios: [scenario] } }));
    writeFileSync(join(blocked, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: scenario.name, result: 'PASS' }] }));
    assert.throws(() => finalizeRecording(blocked, 'cli', scenario, 'cli-command-v1', payload), /Unsupported or unsafe/);
    assert.deepEqual(recordingStatus(blocked, 'cli', scenario), { status: 'not-captured' });
  }
});

test('recording identities are canonical and distinct from slug collisions', () => {
  assert.equal(intentHash('cli', scenario), intentHash('cli', { ...scenario, name: 'different' }));
  for (const [kind, s] of [['api', scenario], ['cli', { ...scenario, steps: 'Run it ' }], ['cli', { ...scenario, expected: 'Other' }]]) assert.notEqual(intentHash(kind, s), intentHash('cli', scenario));
  assert.equal(scenarioId(' Log in '), scenarioId('log IN'));
  assert.notEqual(scenarioId('log-in'), scenarioId('log in'));
  assert.notEqual(intentHash('cli', { steps: 'a', expected: 'bc' }), intentHash('cli', { steps: 'ab', expected: 'c' }));
  assert.throws(() => intentHash('unknown', scenario));
  assert.throws(() => scenarioId('  '));
});

test('status files are immutable, safe and ignored if stale or malformed', t => {
  const run = runDir(t);
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
  assert.throws(() => markNotRecordable(run, 'cli', scenario, 'arbitrary secret'), /Invalid/);
  markNotRecordable(run, 'cli', scenario, 'unsafe');
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-recordable', reason: 'unsafe' });
  assert.throws(() => markNotRecordable(run, 'cli', scenario, 'incomplete'), /EEXIST/);
  assert.deepEqual(recordingStatus(run, 'cli', { ...scenario, steps: 'Changed' }), { status: 'not-captured' });
  const dir = join(run, 'recording');
  assert.equal(readdirSync(dir).length, 1);
  const path = join(dir, `${scenarioId(scenario.name)}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, status: 'captured', actions: [] }));
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
  writeFileSync(path, '{');
  writeFileSync(join(dir, '.tmp-interrupted'), '{');
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
});

test('status files and directories cannot be symlinks', t => {
  const run = runDir(t), other = runDir(t);
  symlinkSync(other, join(run, 'recording'));
  assert.throws(() => markNotRecordable(run, 'cli', scenario, 'unsafe'), /Unsafe/);
  assert.deepEqual(recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
  const run2 = runDir(t);
  mkdirSync(join(run2, 'recording'));
  symlinkSync(join(other, 'target'), join(run2, 'recording', `${scenarioId(scenario.name)}.json`));
  assert.deepEqual(recordingStatus(run2, 'cli', scenario), { status: 'not-captured' });
  assert.throws(() => markNotRecordable(run2, 'cli', scenario, 'unsafe'), /EEXIST/);
});

test('concurrent writers publish exactly one complete status', async t => {
  const run = runDir(t);
  const module = resolve(import.meta.dirname, '../recordings.mjs');
  const script = `import { markNotRecordable } from ${JSON.stringify('file://' + module)}; try { markNotRecordable(process.argv[1], 'cli', ${JSON.stringify(scenario)}, process.argv[2]); } catch (e) { if (e.code !== 'EEXIST') throw e; }`;
  const child = reason => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, run, reason]);
    let stderr = ''; p.stderr.on('data', x => { stderr += x; });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all(['unsafe', 'incomplete', 'unsupported'].map(child));
  const status = recordingStatus(run, 'cli', scenario);
  assert.equal(status.status, 'not-recordable');
  assert.ok(['unsafe', 'incomplete', 'unsupported'].includes(status.reason));
  assert.deepEqual(readdirSync(join(run, 'recording')), [`${scenarioId(scenario.name)}.json`]);
});

test('trusted codec finalizes only a completed matching PASS and renders validated actions and assertions', async t => {
  const store = await fixtureStore(t), run = runDir(t);
  const payload = { action: 'inspect', assertion: 'success' };
  completed(run, 'cli', scenario, 'FAIL');
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload), /PASS/);
  completed(run);
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', cleanup: 'incomplete', scenarios: [{ name: scenario.name, result: 'PASS' }] }));
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload), /complete/);
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: scenario.name, result: 'PASS' }, { name: scenario.name, result: 'PASS' }] }));
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload), /PASS/);
  completed(run);
  assert.throws(() => store.finalizeRecording(run, 'cli', { ...scenario, steps: 'different' }, 'fixture-v1', payload), /PASS/);
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'missing', payload), /Unsupported/);
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, ['fixture-v1'], payload), /Unsupported/);
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', { ...payload, secret: 'sensitive' }), /unsafe/);
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({ kind: 'cli', credentials: { token: { env: 'TOKEN' } }, request: { scenarios: [scenario] } }));
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload), /unsafe/);
  completed(run);
  store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload);
  assert.deepEqual(store.recordingStatus(run, 'cli', scenario), { status: 'recorded', steps: [{ action: 'inspect', assertion: 'success' }] });
  assert.throws(() => store.finalizeRecording(run, 'cli', scenario, 'fixture-v1', payload), /EEXIST/);
  assert.deepEqual(store.recordingStatus(run, 'cli', { ...scenario, expected: 'changed' }), { status: 'not-captured' });
  completed(run, 'cli', scenario, 'FAIL');
  assert.deepEqual(store.recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
});

test('invalid, interrupted, unsafe or tampered recording envelopes never display as recorded', async t => {
  const store = await fixtureStore(t), run = runDir(t);
  completed(run);
  const dir = join(run, 'recording'); mkdirSync(dir);
  const path = join(dir, `${scenarioId(scenario.name)}.json`);
  const envelope = { version: 1, status: 'recorded', kind: 'cli', scenarioId: scenarioId(scenario.name), intentHash: intentHash('cli', scenario), codec: 'fixture-v1', payload: { action: 'inspect', assertion: 'success' } };
  for (const bad of [
    { ...envelope, version: 2 }, { ...envelope, codec: 'unknown' }, { ...envelope, codec: ['fixture-v1'] },
    { ...envelope, payload: { action: 'secret=value', assertion: 'success' } },
    { ...envelope, extra: 'secret' }, { ...envelope, intentHash: 'stale' },
  ]) {
    writeFileSync(path, JSON.stringify(bad));
    assert.deepEqual(store.recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
  }
  writeFileSync(path, '{');
  writeFileSync(join(dir, '.tmp-interrupted'), JSON.stringify(envelope));
  assert.deepEqual(store.recordingStatus(run, 'cli', scenario), { status: 'not-captured' });
});

test('concurrent finalizers publish only one complete validated envelope', async t => {
  const dir = copyStore(t), run = runDir(t);
  writeFileSync(join(dir, 'mcp/recording-codecs.mjs'), `export const RECORDING_CODECS = Object.freeze({ 'fixture-v1': { validate: p => p === 'safe', describe: () => [{action:'inspect', assertion:'success'}] } });`);
  completed(run);
  const module = new URL(`file://${join(dir, 'mcp/recordings.mjs')}`).href;
  const script = `import { finalizeRecording } from ${JSON.stringify(module)}; try { finalizeRecording(process.argv[1], 'cli', ${JSON.stringify(scenario)}, 'fixture-v1', 'safe'); } catch (e) { if (e.code !== 'EEXIST') throw e; }`;
  const child = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, run]);
    let stderr = ''; p.stderr.on('data', x => { stderr += x; });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([child(), child(), child()]);
  const store = await import(module);
  assert.deepEqual(store.recordingStatus(run, 'cli', scenario), { status: 'recorded', steps: [{ action: 'inspect', assertion: 'success' }] });
  assert.deepEqual(readdirSync(join(run, 'recording')), [`${scenarioId(scenario.name)}.json`]);
});
