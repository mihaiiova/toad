import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attestScenario, commandAssertions, readExecutionRecords, validateExecutionRecord } from '../../agent/tools/toad-execution.mjs';
import { replayScenario } from '../replay.mjs';
import { registerProject, projectId } from '../projects.mjs';
import { startUi } from '../ui.mjs';

const TOOLS = resolve(import.meta.dirname, '../../agent/tools');
const NAME = 'Checks behavior';
const payload = { program: 'node', args: ['-e', 'console.log("ready")'], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };
function fixture(t, kind = 'cli') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-command-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), run = join(project, '.toad/runs/current'), receipts = join(run, 'receipts/checks');
  mkdirSync(receipts, { recursive: true });
  const env = { ...process.env, TOAD_CLI_SANDBOX: 'none', TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_CONFIG_DIR: join(root, 'config'), TOAD_RECEIPTS_DIR: join(run, 'receipts'), TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_SCENARIOS: JSON.stringify([NAME]), TOAD_EXECUTION_KIND: kind };
  const execute = (tool, args = [], input, extra = {}) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(TOOLS, tool), ...args], { cwd: project, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
  return { root, project, run, receipts, env, execute };
}
async function prepare(f) {
  const result = await f.execute('toad-exec.mjs', ['prepare', f.project]);
  assert.equal(result.code, 0, result.stderr);
  return /Scenario ID: (.+)/.exec(result.stdout)[1];
}
async function structured(f, scenario, name = '01-check', expect = payload.expect) {
  return f.execute('toad-structured-cli.mjs', [], { scenario, receipts: f.receipts, name, ...payload, expect, scenarioName: NAME });
}

test('CLI structured subprocess and replay share attributed typed evidence without changing receipt proofs', async t => {
  const f = fixture(t), scenario = await prepare(f);
  assert.equal((await structured(f, scenario)).code, 0);
  const a = readExecutionRecords(f.run).records[0];
  assert.equal(a.version, 2); assert.equal(a.kind, 'cli'); assert.equal(a.scenarioName, NAME);
  assert.equal(a.outcome, 'PASS'); assert.equal(a.verification.source, 'machine');
  assert.deepEqual(a.steps.map(s => s.assertion), [{ kind: 'exitCode', result: 'PASS' }, { kind: 'stdout', result: 'PASS' }]);
  assert.equal(validateExecutionRecord({ ...a, version: 99 }), false);
  assert.equal(validateExecutionRecord({ ...a, verification: { source: 'guessed', executionIds: [] } }), false);
  const replay = await replayScenario({ codec: 'cli-command-v1', payload }, { workdir: f.project, receipts: f.receipts, name: '02-replay', env: { ...f.env, TOAD_EXECUTION_SCENARIO_NAME: NAME, TOAD_EXECUTION_MODE: 'replay' } });
  assert.equal(replay.result, 'PASS');
  const records = readExecutionRecords(f.run).records;
  assert.deepEqual(new Set(records.map(r => r.mode)), new Set(['agent', 'replay']));
  assert.notEqual(records[0].attemptId, records[1].attemptId);
  assert.match(readFileSync(join(f.receipts, '01-check.txt'), 'utf8'), /result: exit 0/);
});

test('normal CLI/API commands remain operations until explicit evidence-linked attestation; no host context leaks', async t => {
  for (const kind of ['cli', 'api']) {
    const f = fixture(t, kind), scenario = await prepare(f);
    const command = 'node -e \'console.log(JSON.stringify({run:process.env.TOAD_EXECUTION_RUN_DIR,key:process.env.OPENAI_API_KEY}))\'';
    const result = await f.execute('toad-exec.mjs', ['run', f.receipts, '01-normal', scenario, command, '--scenario-name', NAME], undefined, { OPENAI_API_KEY: 'provider-sentinel', TOAD_EXEC_JSON: '1' });
    assert.equal(result.code, 0, result.stderr);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.stdout, '{}\n', 'workload gets neither host execution paths nor provider credentials');
    let records = readExecutionRecords(f.run).records;
    assert.equal(records[0].kind, kind); assert.equal(records[0].assertion, null); assert.equal(records[0].verification, null);
    attestScenario(f.env, { scenarioName: NAME, result: 'PASS', executionIds: [facts.executionId] });
    records = readExecutionRecords(f.run).records;
    const attested = records.find(r => r.operation === 'attestScenario');
    assert.deepEqual(attested.assertion, { kind: 'agentAttestation', result: 'PASS' });
    assert.deepEqual(attested.verification, { source: 'agent', executionIds: [facts.executionId] });
    unlinkSync(join(f.run, records.find(r => r.operation === 'runCommand').artifacts[0].path));
    assert.ok(readExecutionRecords(f.run).errors.length, 'removing cited evidence invalidates completion');
  }
});

test('required receipt failure gives ERROR after pass but cannot erase an observed assertion FAIL; duplicate receipts never overwrite', async t => {
  const f = fixture(t), scenario = await prepare(f);
  writeFileSync(join(f.receipts, '01-check.txt'), 'original evidence');
  assert.equal((await structured(f, scenario)).code, 2);
  assert.equal(readFileSync(join(f.receipts, '01-check.txt'), 'utf8'), 'original evidence');
  assert.equal(readExecutionRecords(f.run).records[0].outcome, 'ERROR');
  writeFileSync(join(f.receipts, '02-fail.txt'), 'original failed-run evidence');
  const failed = await structured(f, scenario, '02-fail', { exitCode: 0, stdout: { equals: 'wrong\n' } });
  assert.equal(failed.code, 1);
  const record = readExecutionRecords(f.run).records.find(r => r.outcome === 'FAIL');
  assert.equal(record.evidenceComplete, false); assert.equal(record.steps[1].assertion.result, 'FAIL');
  assert.throws(() => attestScenario(f.env, { scenarioName: NAME, result: 'PASS', executionIds: [record.id] }));
});

test('unbound/foreign names and symlink receipts fail closed, without creating external evidence', async t => {
  const f = fixture(t), scenario = await prepare(f);
  const unbound = await f.execute('toad-exec.mjs', ['run', f.receipts, '01-no', scenario, 'true']);
  assert.equal(unbound.code, 2);
  const wrong = await f.execute('toad-structured-cli.mjs', [], { scenario, receipts: f.receipts, name: '02-no', ...payload, scenarioName: 'Other scenario' });
  assert.equal(wrong.code, 2);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.run, 'receipts/linked'));
  const unsafe = await f.execute('toad-exec.mjs', ['run', join(f.run, 'receipts/linked/child'), '03-no', scenario, 'true', '--scenario-name', NAME]);
  assert.equal(unsafe.code, 2); assert.equal(existsSync(join(outside, 'child')), false);
});

test('CLI/API timeout and cancellation retain durable ERROR/cancelled operations with no fabricated assertions', async t => {
  for (const kind of ['cli', 'api']) {
    const f = fixture(t, kind), scenario = await prepare(f);
    await f.execute('toad-exec.mjs', ['run', f.receipts, '01-timeout', scenario, 'sleep 20', '--scenario-name', NAME], undefined, { TOAD_COMMAND_TIMEOUT_S: '0.02' });
    assert.equal(readExecutionRecords(f.run).records[0].outcome, 'ERROR');
    const child = spawn(process.execPath, [join(TOOLS, 'toad-exec.mjs'), 'run', f.receipts, '02-cancel', scenario, 'sleep 20', '--scenario-name', NAME], { cwd: f.project, env: f.env, stdio: 'ignore' });
    const closed = new Promise(done => child.on('close', done));
    for (let i = 0; i < 200 && readExecutionRecords(f.run).records.length < 2; i++) await new Promise(done => setTimeout(done, 10));
    // Let the runner install its cancellation handlers after creating the running record.
    await new Promise(done => setTimeout(done, 100)); child.kill('SIGTERM'); await closed;
    const record = readExecutionRecords(f.run).records.find(r => r.outcome === 'cancelled');
    assert.ok(record); assert.equal(record.evidenceComplete, true); assert.deepEqual(record.steps, []);
  }
});

test('API structured/replay asserts HTTP status and body through the existing runner and appears in the shared viewer', async t => {
  const f = fixture(t, 'api');
  const server = createServer((q, r) => { if (q.url === '/drop') return q.socket.destroy(); r.writeHead(201); r.end('created'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => server.close());
  const api = { method: 'GET', url: `http://127.0.0.1:${server.address().port}/`, headers: {}, body: '', expect: { status: 201, body: { equals: 'created' } } };
  const scenario = await prepare(f);
  const result = await f.execute('toad-structured-api.mjs', [], { scenario, receipts: f.receipts, name: '01-api', payload: api, scenarioName: NAME });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const failed = await replayScenario({ codec: 'api-request-v1', payload: { ...api, expect: { ...api.expect, status: 200 } } }, { workdir: f.project, receipts: f.receipts, name: '02-replay', env: { ...f.env, TOAD_EXECUTION_SCENARIO_NAME: NAME, TOAD_EXECUTION_MODE: 'replay' } });
  assert.equal(failed.result, 'FAIL');
  const records = readExecutionRecords(f.run).records;
  assert.deepEqual(records.map(r => r.kind), ['api', 'api']);
  assert.deepEqual(records[0].steps.map(s => s.assertion.kind), ['httpStatus', 'body']);
  assert.equal(records[1].steps[0].assertion.result, 'FAIL');
  const error = await f.execute('toad-structured-api.mjs', [], { scenario, receipts: f.receipts, name: '03-error', payload: { ...api, url: api.url + 'drop' }, scenarioName: NAME });
  assert.equal(error.code, 2);
  const errorRecord = readExecutionRecords(f.run).records.find(r => r.outcome === 'ERROR');
  assert.equal(errorRecord.kind, 'api'); assert.deepEqual(errorRecord.steps, []);
  const cli = fixture(t);
  assert.equal((await structured(cli, await prepare(cli))).code, 0);
  const old = process.env.TOAD_CONFIG_DIR; process.env.TOAD_CONFIG_DIR = f.env.TOAD_CONFIG_DIR;
  t.after(() => { if (old === undefined) delete process.env.TOAD_CONFIG_DIR; else process.env.TOAD_CONFIG_DIR = old; });
  registerProject(f.project); registerProject(cli.project);
  const ui = await startUi({ port: 0 }); t.after(() => ui.server.close());
  const detail = await (await fetch(`${ui.url}api/projects/${projectId(f.project)}/runs/current`)).json();
  assert.deepEqual(detail.execution.records.map(r => [r.kind, r.scenarioName]), [['api', NAME], ['api', NAME], ['api', NAME]]);
  const cliDetail = await (await fetch(`${ui.url}api/projects/${projectId(cli.project)}/runs/current`)).json();
  assert.equal(cliDetail.execution.records[0].kind, 'cli');
  assert.equal(cliDetail.execution.records[0].scenarioName, NAME);
  assert.deepEqual(commandAssertions(payload.expect, { exitCode: 0, stdout: 'partial', outputTruncated: true })[1], { kind: 'stdout', result: 'ERROR' });
});
