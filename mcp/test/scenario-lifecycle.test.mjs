import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { runScenarioLifecycle } from '../scenario-lifecycle.mjs';
import { runProject, validateProjectHandoff } from '../run.mjs';
import { readProjectConfig, suiteHandoff, withDefaults } from '../projects.mjs';
import { replayChoices, replayScenario } from '../replay.mjs';
import { recordingStatus, scenarioId, intentHash } from '../recordings.mjs';
import { readExecutionRecords, attestScenario, validateExecutionRecord } from '../../agent/tools/toad-execution.mjs';
import { parseRunArgs, suiteRunHandoff, toadRun } from '../toad-run.mjs';
import { suiteFromHandoff } from '../suite-recordings.mjs';

const NAME = 'Fixture behavior';
const scenario = { name: NAME, steps: 'Read the prepared fixture twice.', expected: 'It remains available.' };
const hooks = { before: ['printf fixture > fixture.txt'], after: ['rm fixture.txt'], writes: false };

function fakeAdapters(events, behavior = {}) {
  return {
    async prepare(signal) { events.push('prepare'); if (behavior.noContext) return null; return { signal }; },
    async command(context, phase, command, index, signal) {
      events.push(`${phase}:${index}:${command}`);
      if (behavior.cancelAt === phase) { behavior.cancel.abort(); assert.equal(context.signal.aborted, true); }
      if (phase === 'after') assert.equal(signal.aborted, false, 'cleanup gets a fresh deadline');
      return behavior.fail !== `${phase}:${index}`;
    },
    async product() { events.push('product'); if (behavior.productThrow) throw new Error('product stopped'); return { result: behavior.productResult ?? 'PASS' }; },
    async capture(context, product) { events.push(`capture:${product?.result ?? 'none'}`); if (behavior.captureThrow) throw new Error('disk failed'); },
    async close(context, options) { events.push(`close:${options.retain}`); },
  };
}

test('attempt lifecycle exact sequential order, partial preparation and finally evidence before teardown', async () => {
  for (const behavior of [{}, { productResult: 'FAIL' }, { fail: 'before:1' }, { fail: 'after:0' }, { productThrow: true }, { captureThrow: true }, { noContext: true }]) {
    const events = [];
    const result = await runScenarioLifecycle({ before: ['one', 'two'], after: ['clean', 'last'] }, fakeAdapters(events, behavior));
    if (behavior.noContext) { assert.deepEqual(events, ['prepare']); assert.equal(result.cleanupUnavailable, true); continue; }
    assert.deepEqual(events.slice(0, 3), ['prepare', 'before:0:one', 'before:1:two']);
    assert.equal(events.filter(e => e === 'product').length, behavior.fail === 'before:1' ? 0 : 1);
    assert.ok(events.findIndex(e => e.startsWith('capture:')) < events.indexOf('after:0:clean'));
    assert.deepEqual(events.slice(-3), ['after:0:clean', 'after:1:last', `close:${!!behavior.captureThrow}`]);
    assert.equal(result.cleanupError, behavior.fail === 'after:0');
    assert.equal(result.evidenceError, !!behavior.captureThrow);
  }
});

test('cancellation after partial before still cleans under independent signal, without product or repeated hooks', async () => {
  const cancel = new AbortController(), events = [];
  const result = await runScenarioLifecycle({ before: ['one', 'two'], after: ['clean'], signal: cancel.signal }, fakeAdapters(events, { cancelAt: 'before', cancel }));
  assert.deepEqual(events, ['prepare', 'before:0:one', 'capture:none', 'after:0:clean', 'close:false']);
  assert.equal(result.cancelled, true);
  const stopped = [];
  await runScenarioLifecycle({ signal: AbortSignal.abort(), after: ['clean'] }, fakeAdapters(stopped));
  assert.deepEqual(stopped, []);
});

test('attempt and cleanup timeouts bound distinct signals and stop further teardown launches', async () => {
  const events = [];
  const waitAbort = signal => new Promise(done => signal.addEventListener('abort', done, { once: true }));
  const result = await runScenarioLifecycle({ before: [], after: ['one', 'two'], timeoutSeconds: 0.01, cleanupTimeoutSeconds: 0.01 }, {
    prepare: async () => ({}),
    product: async (context, signal) => { await waitAbort(signal); events.push('product-stopped'); },
    capture: async () => events.push('capture'),
    command: async (context, phase, command, i, signal) => { events.push(command); await waitAbort(signal); return false; },
    close: async () => events.push('close'),
  });
  assert.deepEqual(events, ['product-stopped', 'capture', 'one', 'close']);
  assert.equal(result.cancelled, true); assert.equal(result.cleanupError, true);
});

function fixture(t, behavior = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), agent = join(root, 'agent');
  mkdirSync(join(project, '.toad/runs'), { recursive: true });
  writeFileSync(join(project, '.toad/.gitignore'), '.env\nruns/\n');
  mkdirSync(join(agent, '.pi/git/github.com/mihaiiova/pi-commands'), { recursive: true });
  writeFileSync(join(agent, '.pi/git/github.com/mihaiiova/pi-commands/package.json'), '{}');
  cpSync(resolve(import.meta.dirname, '../../agent/tools'), join(agent, 'tools'), { recursive: true });
  const pi = join(agent, 'fake-pi.mjs');
  writeFileSync(pi, `#!/usr/bin/env node
import fs from 'node:fs'; import {join} from 'node:path'; import {spawnSync} from 'node:child_process';
const behavior = ${JSON.stringify(behavior)};
const name = process.env.TOAD_EXECUTION_SCENARIO_NAME;
const id = process.env.TOAD_ATTEMPT_ID;
if (behavior.cost) { const i=process.argv.indexOf('--session-dir'); const dir=process.argv[i+1]; fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(join(dir,id+'.jsonl'),JSON.stringify({type:'message',message:{role:'assistant',usage:{cost:behavior.cost}}})+'\\n'); }
fs.appendFileSync('launches', JSON.stringify({name,id,time:Date.now()})+'\\n');
const receipts = join(process.env.TOAD_RECEIPTS_DIR, id);
if (behavior.webPayload) {
  const web=spawnSync(process.execPath,['tools/toad-structured-web.mjs'],{encoding:'utf8',input:JSON.stringify({receipts,name:'01-web',payload:behavior.webPayload,scenarioName:name,capture:{scenarioName:name,complete:true}}),env:process.env});
  fs.writeFileSync('web-result',web.stdout);
  if(web.status!==0) throw new Error('web scenario failed: '+web.stdout);
  console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'Verdict: PASS\\nResults:\\n- PASS | '+name}],stopReason:'stop'}]}));
  process.exit(0);
}
const runner = args => spawnSync(process.execPath, ['tools/toad-exec.mjs',...args], {encoding:'utf8',env:{...process.env,TOAD_EXEC_JSON:'1'}});
if (behavior.bypass && runner(['run',receipts,'foreign','00000000-0000-4000-8000-000000000000','printf breach']).status !== 2) throw new Error('foreign workspace accepted');
// Preparation must reuse the native context, not reclone and lose hook files.
const prepare = runner(['prepare', process.env.TOAD_ATTEMPT_SOURCE]);
if (!prepare.stdout.includes(id)) throw new Error('workspace replaced');
if (runner(['prepare','/']).status !== 2) throw new Error('foreign source accepted');
const first = runner(['run',receipts,'01-product',id,'cat fixture.txt']);
const second = runner(['run',receipts,'02-product',id,'cat fixture.txt']);
if (first.status || second.status) throw new Error('fixture not shared across commands');
if (behavior.apiUrl) {
  const request={scenario:id,receipts,name:'03-api',scenarioName:name,payload:{method:'GET',url:behavior.apiUrl,headers:{},body:'',expect:{status:200,body:{equals:'fixture'}}}};
  const api=spawnSync(process.execPath,['tools/toad-structured-api.mjs'],{encoding:'utf8',input:JSON.stringify(request),env:process.env});
  if(api.status!==0) throw new Error('API assertion failed: '+api.stdout);
}
const facts = JSON.parse(second.stdout);
const {attestScenario} = await import('./tools/toad-execution.mjs');
attestScenario(process.env, {scenarioName:name,result:behavior.fail?'FAIL':'PASS',executionIds:[facts.executionId]});
fs.writeFileSync('product-started','yes');
if (behavior.delay) await new Promise(done=>setTimeout(done,behavior.delay));
console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'Verdict: '+(behavior.fail?'FAIL':'PASS')+'\\nResults:\\n- '+(behavior.fail?'FAIL':'PASS')+' | '+name}],stopReason:'stop'}]}));
`, { mode: 0o755 });
  chmodSync(pi, 0o755);
  const dirs = { TOAD_CONFIG_DIR: join(root, 'config'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_CACHE_DIR: join(root, 'cache') };
  const old = Object.fromEntries(Object.keys(dirs).map(k => [k, process.env[k]])); Object.assign(process.env, dirs);
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const env = { ...process.env, ...dirs, TOAD_AGENT_DIR: agent, TOAD_PI: pi, TOAD_CLI_SANDBOX: 'none', OPENAI_API_KEY: 'ambient-provider-sentinel' };
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'cat fixture.txt' }, request: { goal: 'Check fixtures', scenarios: [scenario] }, attempt: hooks };
  const execute = async (h = handoff, signal = new AbortController().signal, extraEnv = {}, options = {}) => {
    let run;
    const result = await runProject({ project_path: project, handoff: h }, { signal }, { env: { ...env, ...extraEnv }, onRun: r => { run = r; }, ...options });
    return { result: result.structuredContent, run, evidence: readExecutionRecords(run) };
  };
  return { root, project, agent, env, handoff, execute };
}

test('runProject owns one workspace per scenario, setup once/run, fresh attempts and required separate hook receipts', async t => {
  const f = fixture(t);
  const h = { ...f.handoff, target: { ...f.handoff.target, setup: ['printf setup > installed.txt'] }, request: { ...f.handoff.request, scenarios: [scenario, { ...scenario, name: 'Second scenario' }] }, attempt: { ...hooks, before: ['test -f installed.txt; test ! -f fixture.txt; printf fixture > fixture.txt'], after: ['test -f fixture.txt; rm fixture.txt'] } };
  const { result, run, evidence } = await f.execute(h);
  assert.equal(result.verdict, 'PASS'); assert.deepEqual(evidence.errors, []);
  assert.equal(readdirSync(join(run, 'receipts/setup')).length, 1);
  const launches = readFileSync(join(f.agent, 'launches'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 2); assert.notEqual(launches[0].id, launches[1].id);
  for (const launch of launches) {
    const records = evidence.records.filter(r => r.attemptId === launch.id);
    assert.deepEqual(records.map(r => r.operation), ['beforeAttempt', 'runCommand', 'runCommand', 'attestScenario', 'afterAttempt']);
    assert.equal(records[0].version, 3); assert.equal(records[0].verification, null);
    assert.equal(validateExecutionRecord(records[0]), true);
    assert.ok(records.every(r => r.evidenceComplete));
    assert.equal(existsSync(join(f.env.TOAD_CACHE_DIR, 'scenarios', launch.id)), false);
    const snapshot = JSON.parse(readFileSync(join(run, 'attempts', launch.id + '.json')));
    assert.ok(Date.parse(snapshot.capturedAt) <= Date.parse(records.at(-1).startedAt));
    assert.equal(recordingStatus(run, 'cli', { ...scenario, name: launch.name }).reason, 'attempt-hooks');
  }
  // A requested retry is another whole owned attempt, not reuse of local fixture files.
  const next = await f.execute(h);
  assert.equal(next.result.verdict, 'PASS');
  assert.notEqual(next.evidence.records[0].attemptId, evidence.records[0].attemptId);
  assert.equal(existsSync(join(f.project, 'fixture.txt')), false);
});

test('native before failure skips product but after runs; teardown ERROR does not erase observed product FAIL', async t => {
  const f = fixture(t);
  const before = await f.execute({ ...f.handoff, attempt: { ...hooks, before: ['printf partial > fixture.txt', 'exit 7', 'touch should-not-exist'], after: ['test -f fixture.txt; test ! -f should-not-exist; rm fixture.txt'] } });
  assert.equal(before.result.verdict, 'ERROR'); assert.equal(existsSync(join(f.agent, 'launches')), false);
  assert.deepEqual(before.evidence.records.map(r => [r.phase, r.outcome]), [['before', 'completed'], ['before', 'ERROR'], ['after', 'completed']]);
  const after = await f.execute({ ...f.handoff, attempt: { ...hooks, after: ['exit 9', 'rm fixture.txt'] } });
  assert.equal(after.result.verdict, 'ERROR');
  assert.equal(after.evidence.records.at(-1).outcome, 'completed', 'later cleanup still attempted');
  const failing = fixture(t, { fail: true });
  const fail = await failing.execute({ ...failing.handoff, attempt: { ...hooks, after: ['exit 8'] } });
  assert.equal(fail.result.verdict, 'FAIL'); assert.equal(fail.result.scenarios[0].result, 'FAIL');
});

test('native cancellation and overall deadline still attempt bounded teardown, not a workflow per-scenario timeout multiplier', async t => {
  const f = fixture(t, { delay: 10000 });
  const controller = new AbortController();
  const pending = f.execute(f.handoff, controller.signal);
  for (let i = 0; i < 1000 && !existsSync(join(f.agent, 'product-started')); i++) await new Promise(done => setTimeout(done, 10));
  controller.abort();
  const stopped = await pending;
  assert.ok(stopped.evidence.records.some(r => r.phase === 'after' && r.evidenceComplete));
  assert.equal(stopped.result.verdict, 'ERROR');
  const deadline = await f.execute({ ...f.handoff, request: { ...f.handoff.request, scenarios: [scenario, { ...scenario, name: 'Not launched after deadline' }] } }, undefined, { TOAD_TEST_TIMEOUT_MS: '800' });
  assert.equal(deadline.result.verdict, 'ERROR');
  const launches = readFileSync(join(f.agent, 'launches'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.filter(l => l.name === 'Not launched after deadline').length, 0);
});

test('hook credentials are explicit subset, redacted in receipts, with no ambient keys or other selected test references', async t => {
  const f = fixture(t);
  const h = { ...f.handoff, credentials: { app: { env: 'FIXTURE_KEY' }, other: { env: 'OTHER_KEY' } }, attempt: { ...hooks, credentials: ['FIXTURE_KEY'], before: ['test -n "$FIXTURE_KEY"; test -z "$OTHER_KEY"; test -z "$OPENAI_API_KEY"; printf "%s" "$FIXTURE_KEY"; printf fixture > fixture.txt'] } };
  writeFileSync(join(f.project, '.toad/.env'), 'FIXTURE_KEY=fixture-secret-sentinel\nOTHER_KEY=test-secret-sentinel\n');
  const { result, run, evidence } = await f.execute(h);
  assert.equal(result.verdict, 'PASS');
  const receipt = readFileSync(join(run, evidence.records.find(r => r.phase === 'before').artifacts[0].path), 'utf8');
  assert.ok(!receipt.includes('fixture-secret-sentinel')); assert.match(receipt, /\[secret:FIXTURE_KEY\]/);
  assert.throws(() => attestScenario({ TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_KIND: 'cli', TOAD_EXECUTION_SCENARIOS: JSON.stringify([NAME]) }, { scenarioName: NAME, result: 'PASS', executionIds: [evidence.records[0].id] }), /completed scenario operations/);
});

test('definition/default/suite/save seams keep one hook model and reject unsafe/static web configurations before launch', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.toad/toad.yaml'), JSON.stringify({ cli: { workdir: '.', program: 'cat fixture.txt', attempt: hooks } }));
  const config = readProjectConfig(join(f.project, '.toad'));
  const suite = { name: 'fixture', kind: 'cli', goal: 'Check', scenarios: [scenario] };
  const h = withDefaults(suiteRunHandoff(suite, suite.scenarios), config, f.project);
  assert.deepEqual(h.attempt, hooks); assert.equal(h.target.attempt, undefined);
  assert.deepEqual(suiteFromHandoff(h, config, f.project).attempt, hooks);
  assert.deepEqual(suiteHandoff({ ...suite, attempt: hooks }).attempt, hooks);
  assert.deepEqual(validateProjectHandoff(h).attempt, hooks);
  for (const change of [
    { request: { goal: 'Goal only' } },
    { request: { goal: 'Duplicate', scenarios: [scenario, scenario] } },
    { attempt: { ...hooks, credentials: ['APP_KEY', 'APP_KEY'] }, credentials: { app: { env: 'APP_KEY' } } },
    { attempt: { ...hooks, workdir: f.root } },
    { attempt: { ...hooks, credentials: ['MISSING'] } },
    { credentials: { key: { env: 'OPENAI_API_KEY' } }, attempt: { ...hooks, credentials: ['OPENAI_API_KEY'] } },
    { credentials: { key: { env: 'PATH' } }, attempt: { ...hooks, credentials: ['PATH'] } },
    { attempt: { ...hooks, cleanup_timeout_seconds: 121 } },
  ]) await assert.rejects(f.execute({ ...f.handoff, ...change }));
  writeFileSync(join(f.project, '.toad/toad.yaml'), JSON.stringify({ web: { attempt: { ...hooks, workdir: '.' } } }));
  assert.equal(readProjectConfig(join(f.project, '.toad')).web.attempt.workdir, '.');
  // Avoid making subsequent web rejection inherit the explicit workdir just tested.
  writeFileSync(join(f.project, '.toad/toad.yaml'), '{}');
  const web = { ...f.handoff, kind: 'web', target: { url: 'http://example.test' } };
  await assert.rejects(f.execute(web), /trusted fixture workdir/);
  assert.ok(validateProjectHandoff({ ...web, attempt: { ...hooks, workdir: f.project } }));
  assert.equal(existsSync(join(f.agent, 'launches')), false);
});

test('effective hook writes cannot bypass suite allow-writes; stale saved recording never bypasses lifecycle, hook-free replay remains available', async t => {
  const f = fixture(t);
  const suites = join(f.project, '.toad/suites'); mkdirSync(suites);
  const suite = { name: 'fixture', kind: 'cli', target: f.handoff.target, goal: 'Check', scenarios: [scenario] };
  writeFileSync(join(suites, 'fixture.yaml'), JSON.stringify({ ...suite, name: undefined, writes: false, attempt: { ...hooks, writes: true } }));
  const errors = [];
  assert.equal(await toadRun(parseRunArgs(['--project', f.project, '--json']), { env: f.env, out: () => {}, err: x => errors.push(x) }), 3);
  assert.match(errors.join(''), /allow-writes/); assert.equal(existsSync(join(f.agent, 'launches')), false);
  // Also gate project-default hooks rather than just suite-local writes.
  writeFileSync(join(suites, 'fixture.yaml'), JSON.stringify({ ...suite, name: undefined, writes: false }));
  writeFileSync(join(f.project, '.toad/toad.yaml'), JSON.stringify({ cli: { attempt: { ...hooks, writes: true } } }));
  assert.equal(await toadRun(parseRunArgs(['--project', f.project]), { env: f.env, out: () => {}, err: () => {} }), 3);
  const payload = { program: 'printf', args: ['ready'], expect: { exitCode: 0, stdout: { equals: 'ready' } } };
  const envelope = { version: 1, status: 'recorded', kind: 'cli', scenarioId: scenarioId(NAME), intentHash: intentHash('cli', scenario), codec: 'cli-command-v1', payload };
  mkdirSync(join(suites, 'fixture.recordings')); writeFileSync(join(suites, 'fixture.recordings', scenarioId(NAME) + '.json'), JSON.stringify(envelope));
  const withHooks = replayChoices(f.project, { ...suite, attempt: hooks }, {}, [scenario]);
  assert.equal(replayChoices(f.project, { ...suite, attempt: hooks }, {}, [scenario], { replay: false })[0].mode, 'agent');
  assert.equal(withHooks[0].mode, 'agent'); assert.match(withHooks[0].reason, /hooks.*lifecycle/);
  assert.equal(replayChoices(f.project, suite, {}, [scenario])[0].mode, 'replay');
  const blocked = await replayScenario(envelope, { handoff: { attempt: hooks } }); assert.equal(blocked.result, 'ERROR');
  const receipts = join(f.root, 'replay-receipts'); mkdirSync(receipts);
  const replay = await replayScenario(envelope, { workdir: f.project, receipts, env: { ...f.env, TOAD_RECEIPTS_DIR: receipts } });
  assert.equal(replay.result, 'PASS');
});

test('native hook output limit, required receipt loss and backend preflight failures cannot pass or fall back to host', async t => {
  const f = fixture(t);
  const limited = await f.execute({ ...f.handoff, attempt: { ...hooks, before: ['printf fixture > fixture.txt; node -e "process.stdout.write(\'x\'.repeat(3*1024*1024))"'] } });
  assert.equal(limited.result.verdict, 'ERROR');
  const before = limited.evidence.records.find(r => r.phase === 'before');
  assert.equal(before.outcome, 'ERROR'); assert.equal(before.evidenceComplete, true);
  assert.match(readFileSync(join(limited.run, before.artifacts[0].path), 'utf8'), /output: truncated/);
  assert.ok(limited.evidence.records.some(r => r.phase === 'after'));
  assert.equal(existsSync(join(f.agent, 'launches')), false);
  const missing = await f.execute(f.handoff, undefined, { TOAD_CLI_SANDBOX: 'container', TOAD_CONTAINER_RUNTIME: 'not-a-supported-runtime' });
  assert.equal(missing.result.verdict, 'ERROR');
  assert.equal(missing.evidence.records.length, 0);
  assert.match(readFileSync(join(missing.run, 'reports/report.md'), 'utf8'), /cleanup unavailable: no owned sandbox/);
  assert.equal(existsSync(join(f.agent, 'launches')), false);
  const slow = await f.execute({ ...f.handoff, attempt: { ...hooks, before: ['printf fixture > fixture.txt; sleep 20'], timeout_seconds: 1 } });
  assert.equal(slow.result.verdict, 'ERROR');
  assert.ok(slow.evidence.records.some(r => r.phase === 'before' && ['ERROR', 'cancelled'].includes(r.outcome)));
  assert.ok(slow.evidence.records.some(r => r.phase === 'after'));
});

test('hook receipts cannot impersonate product assertion or optional diagnostic evidence', async t => {
  const f = fixture(t);
  const { run, evidence } = await f.execute();
  const before = evidence.records.find(r => r.phase === 'before');
  assert.equal(validateExecutionRecord({ ...before, assertion: { kind: 'agentAttestation', result: 'PASS' } }), false);
  assert.equal(validateExecutionRecord({ ...before, verification: { source: 'machine', executionIds: [] } }), false);
  assert.equal(validateExecutionRecord({ ...before, phase: 'diagnostic' }), false);
  assert.equal(validateExecutionRecord({ ...before, artifacts: before.artifacts.map(a => ({ ...a, kind: 'screenshot' })) }), false);
  assert.equal(validateExecutionRecord({ ...before, outcome: 'PASS' }), false);
  assert.equal(validateExecutionRecord({ ...before, outcome: 'FAIL' }), false);
  const path = join(run, before.artifacts[0].path);
  rmSync(path);
  const changed = readExecutionRecords(run);
  assert.ok(changed.errors.some(e => e.includes('receipt')));
  assert.equal(changed.records.find(r => r.id === before.id).evidenceComplete, false);
});

test('native web fixtures use sandbox commands in the explicit workdir without opening a browser shell', async t => {
  const f = fixture(t);
  const web = { ...f.handoff, kind: 'web', target: { url: 'http://example.test' }, attempt: { ...hooks, workdir: f.project, before: ['printf fixture > fixture.txt', 'exit 1'] } };
  const result = await f.execute(web);
  assert.equal(result.result.verdict, 'ERROR');
  assert.deepEqual(result.evidence.records.map(r => [r.kind, r.phase]), [['web', 'before'], ['web', 'before'], ['web', 'after']]);
  assert.ok(result.evidence.records.every(r => r.version === 3 && r.verification === null && r.evidenceComplete));
  assert.equal(existsSync(join(f.agent, 'launches')), false);
  assert.equal(existsSync(join(f.project, 'fixture.txt')), false);
});


test('sequential hook workflows share one aggregate cost allowance', async t => {
  const f = fixture(t, { cost: 0.75 });
  const h = { ...f.handoff, request: { ...f.handoff.request, scenarios: [scenario, { ...scenario, name: 'Over budget scenario' }] } };
  const { result, evidence } = await f.execute(h, undefined, {}, { maxCost: 0.5 });
  assert.equal(result.status, 'cost_limit'); assert.equal(result.verdict, 'ERROR');
  assert.equal(result.cost, 0.75);
  const launches = readFileSync(join(f.agent, 'launches'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 1, 'no fresh per-workflow allowance');
  assert.ok(evidence.records.some(r => r.phase === 'after' && r.evidenceComplete));
});


test('API attempts retain hook files through real HTTP product assertions on the shared executor', async t => {
  const server = createServer((q, r) => { r.end('fixture'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const f = fixture(t, { apiUrl: url });
  const { result, evidence } = await f.execute({ ...f.handoff, kind: 'api', target: { workdir: f.project, url } });
  assert.equal(result.verdict, 'PASS');
  assert.ok(evidence.records.every(r => r.kind === 'api'));
  const product = evidence.records.find(r => r.operation === 'structuredCommand');
  assert.deepEqual(product.steps.map(s => s.assertion), [{kind:'httpStatus',result:'PASS'},{kind:'body',result:'PASS'}]);
  assert.equal(new Set(evidence.records.map(r => r.attemptId)).size, 1);
});

test('native after deadline bounds all after commands and never starts remaining cleanup after expiry', async t => {
  const f = fixture(t);
  const { result, evidence } = await f.execute({ ...f.handoff, attempt: { ...hooks, after: ['sleep 20', 'rm fixture.txt'], cleanup_timeout_seconds: 1 } });
  assert.equal(result.verdict, 'ERROR');
  assert.equal(evidence.records.filter(r => r.phase === 'after').length, 1);
  assert.ok(['cancelled','ERROR'].includes(evidence.records.at(-1).outcome));
  assert.match(readFileSync(join(result.run, 'reports/report.md'), 'utf8'), /cleanup failed/);
});


test('attempt-owned command IDs cannot be substituted to bypass native fixture ownership', async t => {
  const f = fixture(t, { bypass: true });
  const { result, evidence } = await f.execute();
  assert.equal(result.verdict, 'ERROR');
  assert.ok(evidence.errors.length);
  assert.ok(evidence.records.some(r => r.phase === 'after' && r.evidenceComplete), 'ownership error still finalizes the owned context');
});


test('web hook happy path uses the existing structured browser executor and never captures despite complete capture request', async t => {
  const payload = { steps: [{ action: 'goto', url: 'http://example.test/' }, { action: 'expectVisible', target: { role: 'heading', name: 'Fixture' } }] };
  const f = fixture(t, { webPayload: payload });
  const app = join(f.root, 'app.json');
  writeFileSync(app, JSON.stringify({pages:{'/':{elements:[{role:'heading',name:'Fixture'}]}}}));
  const h = { ...f.handoff, kind: 'web', target: { url: 'http://example.test' }, attempt: { ...hooks, workdir: f.project } };
  const { result, run, evidence } = await f.execute(h, undefined, { TOAD_WEB_DRIVER: JSON.stringify([process.execPath, resolve(import.meta.dirname, 'fake-web-driver.mjs')]), FAKE_WEB_APP: app, FAKE_WEB_DIAGNOSTICS: '1' });
  assert.equal(result.verdict, 'PASS');
  assert.equal(new Set(evidence.records.map(r => r.attemptId)).size, 1);
  assert.equal(evidence.records[0].phase, 'before'); assert.equal(evidence.records.at(-1).phase, 'after');
  assert.ok(evidence.records.some(r => r.kind === 'web' && r.version === 1 && r.outcome === 'PASS'));
  assert.equal(JSON.parse(readFileSync(join(f.agent, 'web-result'))).captured, false);
  assert.equal(recordingStatus(run, 'web', scenario).reason, 'attempt-hooks');
});
