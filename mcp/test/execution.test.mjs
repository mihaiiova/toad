import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { artifactReference, beginExecution, executionContext, executionScenarioId, finishExecution, operationReceipt, readExecutionRecords, validateExecutionRecord } from '../../agent/tools/toad-execution.mjs';
import { replayWebPayload, runWebPayload } from '../../agent/tools/toad-web-recording.mjs';
import { finalizeWebCandidates, recordingStatus, scenarioId } from '../recordings.mjs';
import { registerProject, projectId } from '../projects.mjs';
import { startUi } from '../ui.mjs';

const DRIVER = resolve(import.meta.dirname, 'fake-web-driver.mjs');
const LAUNCHER = resolve(import.meta.dirname, '../../agent/tools/playwright-mcp.mjs');
const NAME = 'Home works';
const PAYLOAD = { steps: [{ action: 'goto', url: 'http://app.test/' }, { action: 'expectText', target: { text: 'Hello' }, contains: 'Hello' }] };
function fixture(t, extra = {}) {
  const run = mkdtempSync(join(realpathSync(tmpdir()), 'toad-execution-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  mkdirSync(join(run, 'receipts', 'home-works'), { recursive: true });
  const app = join(run, 'app.json'), log = join(run, 'calls.log');
  writeFileSync(app, JSON.stringify({ pages: { '/': { elements: [{ text: 'Hello' }] } } }));
  return { run, log, receipt: join(run, 'receipts/home-works/01-web.txt'), screenshot: join(run, 'receipts/home-works/01-web.png'),
    env: { ...process.env, TOAD_WEB_DRIVER: JSON.stringify([process.execPath, DRIVER]), FAKE_WEB_APP: app, FAKE_WEB_LOG: log, FAKE_WEB_DIAGNOSTICS: '1', TOAD_WEB_STEP_TIMEOUT_MS: '30', TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_SCENARIOS: JSON.stringify([NAME]), TOAD_EXECUTION_SCENARIO_NAME: NAME, ...extra } };
}
const calls = f => existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse) : [];

test('execution records use canonical identity, independent attempts and strict bounded safe evidence', t => {
  const f = fixture(t);
  assert.equal(executionScenarioId(NAME), scenarioId(NAME));
  assert.throws(() => executionContext(f.env, 'home works'), /Unknown scenario/);
  const context = executionContext(f.env, NAME);
  const a = beginExecution(context, 'browser_navigate');
  const receipt = operationReceipt(a, 'completed');
  finishExecution(a, { outcome: 'completed', artifacts: [receipt], evidenceComplete: true });
  const b = beginExecution(context, 'browser_snapshot');
  const other = beginExecution(executionContext(f.env, NAME), 'browser_snapshot');
  const records = readExecutionRecords(f.run);
  assert.equal(records.records.length, 3);
  assert.equal(records.errors.length, 0);
  assert.equal(validateExecutionRecord(a.record), true);
  assert.equal(validateExecutionRecord({ ...a.record, secret: 'never accepted' }), false);
  assert.equal(validateExecutionRecord({ ...a.record, artifacts: [{ kind: 'receipt', path: '../other-run/receipt' }] }), false);
  assert.equal(validateExecutionRecord({ ...a.record, artifacts: [] }), false, 'complete evidence requires a receipt');
  assert.equal(b.record.sequence, 2);
  assert.equal(other.record.sequence, 1);
  assert.notEqual(a.record.attemptId, other.record.attemptId);
  assert.equal(b.record.evidenceComplete, false, 'a started operation is honestly incomplete');
  assert.throws(() => artifactReference(f.run, join(f.run, '../other-run/file'), 'receipt'));
  symlinkSync(f.receipt, join(f.run, 'receipts/link'));
  assert.throws(() => artifactReference(f.run, join(f.run, 'receipts/link'), 'receipt'));
  const derived = executionContext({ ...f.env, TOAD_EXECUTION_SCENARIOS: '[]' }, 'Explicit derived scenario');
  assert.equal(derived.scenarioSource, 'derived');
});

test('structured web records actual action/check steps, leaves proof folders unchanged and still captures v1', async t => {
  const f = fixture(t);
  assert.deepEqual(await runWebPayload(PAYLOAD, f), { result: 'PASS' });
  const { records, errors } = readExecutionRecords(f.run);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].scenarioId, scenarioId(NAME));
  assert.deepEqual(records[0].steps.map(s => [s.operation, s.assertion?.result ?? null]), [['goto', null], ['expectText', 'PASS']]);
  assert.equal(records[0].outcome, 'PASS');
  assert.equal(records[0].evidenceComplete, true);
  assert.equal(records[0].artifacts[0].path, 'receipts/home-works/01-web.txt');
  assert.deepEqual(readdirSync(join(f.run, 'receipts/home-works')).sort(), ['01-web.png', '01-web.txt']);
  const scenario = { name: NAME, steps: 'Open / and check greeting.', expected: 'Hello' };
  const handoff = { version: 1, kind: 'web', target: { url: 'http://app.test/' }, request: { goal: 'Home', scenarios: [scenario] } };
  writeFileSync(join(f.run, 'handoff.yaml'), JSON.stringify(handoff));
  writeFileSync(join(f.run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: NAME, result: 'PASS' }] }));
  writeFileSync(f.receipt + '.recording.json', JSON.stringify({ version: 1, scenarioName: NAME, payload: PAYLOAD }));
  finalizeWebCandidates(f.run, handoff, [{ name: NAME, result: 'PASS' }]);
  assert.equal(recordingStatus(f.run, 'web', scenario).status, 'recorded');
});

test('failed assertion records its exact step and captures diagnostics before driver close', async t => {
  const f = fixture(t);
  const bad = { steps: [PAYLOAD.steps[0], { action: 'expectUrl', path: '/missing' }] };
  const outcome = await runWebPayload(bad, f);
  assert.equal(outcome.result, 'FAIL');
  assert.equal(outcome.step, 1);
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.steps.length, 2);
  assert.deepEqual(record.steps[1].assertion, { kind: 'expectUrl', result: 'FAIL' });
  assert.equal(record.outcome, 'FAIL');
  assert.deepEqual(record.captures.map(c => [c.kind, c.status]), [['screenshot', 'saved'], ['hierarchy', 'saved'], ['console', 'saved']]);
  const log = calls(f);
  assert.deepEqual(log.slice(-4).map(c => c.tool ?? c.event), ['browser_take_screenshot', 'browser_snapshot', 'browser_console_messages', 'close']);
});

test('optional capture failure preserves PASS; missing required receipt prevents PASS without hiding FAIL', async t => {
  const optional = fixture(t, { FAKE_WEB_MODE: 'capture-fail' });
  assert.equal((await runWebPayload(PAYLOAD, optional)).result, 'PASS');
  assert.deepEqual(readExecutionRecords(optional.run).records[0].captures, [{ kind: 'screenshot', status: 'error' }]);
  const required = fixture(t);
  mkdirSync(required.receipt);
  assert.equal((await runWebPayload(PAYLOAD, required)).result, 'ERROR');
  assert.equal(readExecutionRecords(required.run).records[0].evidenceComplete, false);
  const failed = fixture(t);
  mkdirSync(failed.receipt);
  assert.equal((await runWebPayload({ steps: [PAYLOAD.steps[0], { action: 'expectUrl', path: '/bad' }] }, failed)).result, 'FAIL');
  assert.equal(readExecutionRecords(failed.run).records[0].outcome, 'FAIL');
});

test('unwritable/unsafe metadata prevents browser work and cross-directory evidence is refused', async t => {
  const f = fixture(t);
  symlinkSync(join(f.run, 'receipts'), join(f.run, 'executions'));
  assert.equal((await runWebPayload(PAYLOAD, f)).result, 'ERROR');
  assert.deepEqual(calls(f), []);
  assert.ok(readExecutionRecords(f.run).errors.length);
  const other = fixture(t);
  symlinkSync(join(other.run, 'receipts/home-works'), join(f.run, 'receipts/foreign'));
  assert.throws(() => artifactReference(f.run, join(f.run, 'receipts/foreign/file.txt'), 'receipt'));
});

test('cancelled and timed-out structured work is partial and bounded, with diagnostics attempted before close', async t => {
  const f = fixture(t, { FAKE_WEB_MODE: 'hang' });
  const controller = new AbortController();
  const run = runWebPayload(PAYLOAD, { ...f, signal: controller.signal });
  const timer = setInterval(() => { if (calls(f).some(c => c.tool === 'browser_run_code_unsafe')) controller.abort(); }, 10);
  t.after(() => clearInterval(timer));
  assert.equal((await run).result, 'ERROR');
  clearInterval(timer);
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.outcome, 'cancelled');
  assert.deepEqual(record.steps, [], 'unknown in-flight browser steps are not fabricated');
  assert.equal(record.evidenceComplete, true, 'the cancellation outcome itself has a durable receipt');
  assert.equal(calls(f).at(-1).event, 'close');
  assert.ok(calls(f).some(c => c.tool === 'browser_snapshot'));
});

test('replay uses the same executor and retains separate execution/attempt identity', async t => {
  const f = fixture(t, { TOAD_EXECUTION_MODE: 'replay' });
  const opts = { receipts: join(f.run, 'receipts/home-works'), env: f.env };
  assert.equal((await replayWebPayload(PAYLOAD, { ...opts, name: '01-replay' })).result, 'PASS');
  assert.equal((await replayWebPayload(PAYLOAD, { ...opts, name: '02-replay' })).result, 'PASS');
  const records = readExecutionRecords(f.run).records;
  assert.deepEqual(records.map(r => r.mode), ['replay', 'replay']);
  assert.notEqual(records[0].attemptId, records[1].attemptId);
  assert.notEqual(records[0].id, records[1].id);
});

async function transport(t, extra = {}, shared) {
  const f = shared ?? fixture(t, extra);
  const bin = join(f.run, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${DRIVER}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [LAUNCHER], { env: { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TOAD_RECEIPTS_DIR: join(f.run, 'receipts') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '', id = 0, stderr = '';
  const pending = new Map(), serverRequests = [];
  child.stderr.on('data', c => { stderr += c; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    text += chunk;
    for (let i; (i = text.indexOf('\n')) >= 0;) {
      const line = text.slice(0, i); text = text.slice(i + 1);
      const m = JSON.parse(line);
      if (m.method && m.id !== undefined) {
        serverRequests.push(m);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: { type: 'text', text: 'fixture response' } } }) + '\n');
        continue;
      }
      if (pending.has(m.id)) { pending.get(m.id).done(m.result); pending.delete(m.id); }
    }
  });
  child.on('error', error => { throw error; });
  child.on('close', () => { for (const request of pending.values()) request.fail(new Error('MCP closed')); pending.clear(); });
  const exited = new Promise(done => child.on('close', done));
  t.after(async () => {
    child.stdin.end();
    await Promise.race([exited, new Promise(done => { const timer = setTimeout(done, 2500); timer.unref(); })]);
    child.kill('SIGKILL');
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => reject(new Error(`MCP test timeout: ${stderr}`)), 5000);
    pending.set(current, { done: value => { clearTimeout(timeout); resolve(value); }, fail: error => { clearTimeout(timeout); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await request('tools/list', {});
  return { ...f, child, request, serverRequests, get lastRequestId() { return id; }, call: (name, args) => request('tools/call', { name, arguments: args }) };
}

test('ordinary MCP requires exact binding once; raw credentials/arguments/results never enter records', async t => {
  const f = await transport(t);
  const unbound = await f.call('browser_navigate', { url: 'http://app.test/' });
  assert.equal(unbound.isError, true);
  assert.deepEqual(calls(f), []);
  assert.equal((await f.call('browser_toad_bind_scenario', { scenarioName: 'wrong name' })).isError, true);
  assert.equal((await f.call('browser_toad_bind_scenario', { scenarioName: NAME })).isError, undefined);
  assert.equal((await f.call('browser_toad_bind_scenario', { scenarioName: NAME })).isError, true);
  const response = await f.call('browser_click', { secret: 'SENTINEL-DO-NOT-PERSIST', element: 'Password' });
  assert.equal(response.content[0].text, 'SENTINEL-DO-NOT-PERSIST', 'the relay preserves the normal response');
  assert.match(response.content[1].text, /Toad operation receipt: .*execution-artifacts.*\.txt/);
  assert.match(response.content[1].text, /not a scenario assertion/);
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.operation, 'browser_click');
  assert.equal(record.outcome, 'completed');
  assert.equal(record.assertion, null);
  assert.equal(record.evidenceComplete, true);
  assert.ok(!JSON.stringify(record).includes('SENTINEL'));
  assert.ok(!readFileSync(join(f.run, record.artifacts[0].path), 'utf8').includes('SENTINEL'));
  assert.equal(record.scenarioId, scenarioId(NAME));
});

test('ordinary failure capture is before close and separate sessions never share attempt IDs', async t => {
  const f = await transport(t), second = await transport(t);
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  await second.call('browser_toad_bind_scenario', { scenarioName: NAME });
  assert.equal((await f.call('browser_click', { fail: true })).isError, true);
  await f.call('browser_close', {});
  await second.call('browser_navigate', {});
  const records = readExecutionRecords(f.run).records;
  assert.equal(records[0].outcome, 'ERROR', 'tool failure is not automatically a product assertion FAIL');
  assert.equal(records[0].captures.find(c => c.kind === 'screenshot').status, 'saved');
  assert.notEqual(records[0].attemptId, readExecutionRecords(second.run).records[0].attemptId);
  assert.deepEqual(calls(f).map(c => c.tool), ['browser_click', 'browser_take_screenshot', 'browser_close']);
});

test('goal-only ordinary MCP names are explicit and marked derived', async t => {
  const f = await transport(t, { TOAD_EXECUTION_SCENARIOS: '[]' });
  await f.call('browser_toad_bind_scenario', { scenarioName: 'Derived home check' });
  await f.call('browser_navigate', {});
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.scenarioName, 'Derived home check');
  assert.equal(record.scenarioSource, 'derived');
});

test('viewer exposes a safe timeline, rejects symlink ancestors and preserves historical unavailable state', async t => {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'toad-timeline-project-'));
  const config = mkdtempSync(join(realpathSync(tmpdir()), 'toad-timeline-config-'));
  t.after(() => { rmSync(project, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true }); });
  const oldConfig = process.env.TOAD_CONFIG_DIR;
  process.env.TOAD_CONFIG_DIR = config;
  t.after(() => { if (oldConfig === undefined) delete process.env.TOAD_CONFIG_DIR; else process.env.TOAD_CONFIG_DIR = oldConfig; });
  const run = join(project, '.toad/runs/current'); mkdirSync(join(run, 'receipts'), { recursive: true });
  const old = join(project, '.toad/runs/old'); mkdirSync(old);
  registerProject(project);
  const handle = beginExecution(executionContext({ TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_SCENARIOS: JSON.stringify(['<script>bad</script>']) }, '<script>bad</script>'), 'browser_click');
  finishExecution(handle, { outcome: 'completed', artifacts: [operationReceipt(handle, 'completed')], evidenceComplete: true });
  const { server, url } = await startUi({ port: 0 }); t.after(() => server.close());
  const endpoint = `${url}api/projects/${projectId(project)}/runs/`;
  const current = await (await fetch(endpoint + 'current')).json();
  assert.equal(current.execution.records.length, 1);
  assert.equal((await (await fetch(endpoint + 'old')).json()).execution.available, false);
  const page = await (await fetch(url)).text();
  assert.match(page, /Timeline unavailable/);
  assert.match(page, /esc\(record.scenarioName\)/, 'untrusted names are escaped by the renderer');
  symlinkSync(join(run, 'execution-artifacts'), join(run, 'receipts/linked'));
  const bad = 'receipts/linked/' + handle.record.id + '.txt';
  assert.equal((await fetch(endpoint + 'current/file/' + encodeURIComponent(bad))).status, 404);
  assert.equal((await fetch(endpoint + 'current/file/' + encodeURIComponent('../old/anything'))).status, 400);
});

test('startup timeout records ERROR without inventing browser steps', async t => {
  const f = fixture(t, { FAKE_WEB_MODE: 'init-hang' });
  assert.equal((await runWebPayload(PAYLOAD, { ...f, startMs: 20 })).result, 'ERROR');
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.outcome, 'ERROR');
  assert.deepEqual(record.steps, []);
  assert.equal(record.evidenceComplete, true);
});

test('ordinary timeout records infrastructure ERROR and bounded failure diagnostics', async t => {
  const f = await transport(t, { FAKE_WEB_MODE: 'tool-hang', TOAD_WEB_OPERATION_TIMEOUT_MS: '30' });
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  assert.equal((await f.call('browser_click', {})).isError, true);
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.outcome, 'ERROR');
  assert.equal(record.assertion, null);
  assert.equal(record.captures.find(c => c.kind === 'screenshot').status, 'saved');
});

test('concurrent ordinary sessions in one run preserve separate attempts and never overwrite records', async t => {
  const first = await transport(t);
  const second = await transport(t, {}, first);
  await Promise.all([first.call('browser_toad_bind_scenario', { scenarioName: NAME }), second.call('browser_toad_bind_scenario', { scenarioName: NAME })]);
  await Promise.all([first.call('browser_navigate', {}), second.call('browser_navigate', {})]);
  const records = readExecutionRecords(first.run).records;
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(r => r.sessionId)).size, 2);
  assert.equal(new Set(records.map(r => r.attemptId)).size, 2);
  assert.equal(new Set(records.flatMap(r => r.artifacts.map(a => a.path))).size, 2);
});

test('ordinary mandatory evidence failure is ERROR before any browser operation executes', async t => {
  const f = await transport(t);
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  symlinkSync(join(f.run, 'receipts'), join(f.run, 'executions'));
  assert.equal((await f.call('browser_navigate', {})).isError, true);
  assert.deepEqual(calls(f), []);
  assert.ok(readExecutionRecords(f.run).errors.length);
});

test('ordinary cancellation preserves partial operation and captures before shutdown', async t => {
  const f = await transport(t, { FAKE_WEB_MODE: 'tool-hang' });
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  const response = f.call('browser_click', {});
  const rejected = assert.rejects(response, /MCP closed/);
  const deadline = Date.now() + 2000;
  while (!calls(f).some(c => c.tool === 'browser_click') && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.ok(calls(f).some(c => c.tool === 'browser_click'));
  f.child.kill('SIGTERM');
  await rejected;
  const record = readExecutionRecords(f.run).records[0];
  assert.equal(record.outcome, 'cancelled');
  assert.equal(record.evidenceComplete, true);
  assert.equal(record.assertion, null);
  assert.ok(calls(f).some(c => c.tool === 'browser_take_screenshot'));
});

test('missing optional saved diagnostics do not invalidate required outcome evidence', async t => {
  const f = fixture(t);
  assert.equal((await runWebPayload(PAYLOAD, f)).result, 'PASS');
  rmSync(f.screenshot);
  const result = readExecutionRecords(f.run);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].outcome, 'PASS');
  assert.equal(result.records[0].evidenceComplete, true);
  assert.equal(result.records[0].captures[0].status, 'error');
  assert.ok(result.records[0].artifacts.every(a => a.kind !== 'screenshot'));
  rmSync(f.receipt);
  assert.ok(readExecutionRecords(f.run).errors.length, 'missing mandatory receipt is not optional');
});

test('missing required receipt preserves the observed assertion failure for aggregation', async t => {
  const f = fixture(t);
  const bad = { steps: [PAYLOAD.steps[0], { action: 'expectUrl', path: '/missing' }] };
  assert.equal((await runWebPayload(bad, f)).result, 'FAIL');
  rmSync(f.receipt);
  const result = readExecutionRecords(f.run);
  assert.ok(result.errors.length);
  assert.equal(result.records[0].outcome, 'FAIL');
  assert.equal(result.records[0].evidenceComplete, false);
  assert.deepEqual(result.records[0].steps[1].assertion, { kind: 'expectUrl', result: 'FAIL' });
});

test('ordinary MCP preserves server-initiated request IDs independently of caller IDs', async t => {
  const f = await transport(t, { FAKE_WEB_MODE: 'server-request' });
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  const result = await f.call('browser_click', {});
  assert.equal(f.serverRequests.length, 1);
  assert.equal(f.serverRequests[0].method, 'sampling/createMessage');
  assert.equal(result.content[0].text, 'server request completed');
  assert.equal(readExecutionRecords(f.run).records[0].outcome, 'completed');
});

test('ordinary MCP cancellation notification records the cancelled operation before EOF cleanup', async t => {
  const f = await transport(t, { FAKE_WEB_MODE: 'tool-hang' });
  await f.call('browser_toad_bind_scenario', { scenarioName: NAME });
  const operation = f.call('browser_click', {});
  const cancelledId = f.lastRequestId;
  const closed = assert.rejects(operation, /MCP closed/);
  f.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelledId } }) + '\n');
  f.child.stdin.end();
  await closed;
  const result = readExecutionRecords(f.run);
  assert.equal(result.errors.length, 0);
  assert.equal(result.records[0].outcome, 'cancelled');
  assert.equal(result.records[0].evidenceComplete, true);
  assert.equal(result.records[0].captures.find(c => c.kind === 'screenshot').status, 'saved');
});
