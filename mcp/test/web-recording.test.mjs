import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  decodeWebAnswer, runWebPayload, underBase, validWebPayload, webCandidateFits, webDescription, webPayloadUnder, webReceipt, webScript,
} from '../../agent/tools/toad-web-recording.mjs';
import { finalizeWebCandidates, intentHash, recordingStatus, scenarioId } from '../recordings.mjs';
import { readProjectConfig, readSuites } from '../projects.mjs';
import { replayChoices } from '../replay.mjs';
import { saveSuiteFromRun } from '../suite-recordings.mjs';
import { browserInstalled } from '../setup.mjs';

const tmpdir = () => realpathSync(osTmpdir());
const TOOL = resolve(import.meta.dirname, '../../agent/tools/toad-structured-web.mjs');
const RECORDING = resolve(import.meta.dirname, '../../agent/tools/toad-web-recording.mjs');
const DRIVER = resolve(import.meta.dirname, 'fake-web-driver.mjs');
const CLI = resolve(import.meta.dirname, '../cli.mjs');
const COMMANDS = '.pi/git/github.com/mihaiiova/pi-commands/package.json';
const BASE = 'http://app.test';

const S = { name: 'Saves a name', steps: 'Open /form, enter Ada as the name and save.', expected: 'The saved page greets Ada.' };
const PAYLOAD = { steps: [
  { action: 'goto', url: `${BASE}/form` },
  { action: 'fill', target: { label: 'Name' }, value: 'Ada' },
  { action: 'click', target: { role: 'button', name: 'Save' } },
  { action: 'expectVisible', target: { role: 'heading', name: 'Saved' } },
  { action: 'expectText', target: { role: 'status', name: 'Greeting' }, contains: 'Hello Ada' },
  { action: 'expectUrl', path: '/done' },
] };
const APP = greeting => ({ pages: {
  '/form': { elements: [{ role: 'textbox', label: 'Name', type: 'text' }, { role: 'button', name: 'Save', goto: '/done' }, { role: 'textbox', label: 'Word', type: 'password' }, { role: 'button', name: 'Twin' }, { role: 'button', name: 'Twin' }] },
  '/done': { elements: [{ role: 'heading', name: 'Saved' }, { role: 'status', name: 'Greeting', text: `${greeting} {Name}` }] },
} });

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** The fake Playwright MCP, serving `app`; each call's code is logged. */
function fakeEnv(t, app = APP('Hello'), extra = {}) {
  const dir = temp(t, 'toad-fake-web-');
  writeFileSync(join(dir, 'app.json'), JSON.stringify(app));
  const env = { ...process.env, TOAD_WEB_DRIVER: JSON.stringify([process.execPath, DRIVER]), FAKE_WEB_APP: join(dir, 'app.json'), FAKE_WEB_LOG: join(dir, 'calls.log'), TOAD_WEB_STEP_TIMEOUT_MS: '200', ...extra };
  for (const k of ['TOAD_PLAYWRIGHT_SECRETS_FILE', 'TOAD_RECORDING_ENABLED', 'TOAD_RECEIPTS_DIR']) if (!(k in extra)) delete env[k];
  return { env, calls: () => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse) : [], dir };
}
const envelope = (scenario, payload) => ({ version: 1, status: 'recorded', kind: 'web', scenarioId: scenarioId(scenario.name), intentHash: intentHash('web', scenario), codec: 'web-scenario-v1', payload });

test('web payloads: bounded steps, stable exact locators, a check last, and no credential-like data', () => {
  assert.equal(validWebPayload(PAYLOAD), true);
  const at = (i, step) => ({ steps: PAYLOAD.steps.map((s, j) => (j === i ? step : s)) });
  const bad = {
    'starts with a check': { steps: PAYLOAD.steps.slice(3) },
    'ends with an action': { steps: PAYLOAD.steps.slice(0, 3) },
    'one step': { steps: PAYLOAD.steps.slice(0, 1) },
    'too many steps': { steps: [PAYLOAD.steps[0], ...Array(30).fill(PAYLOAD.steps[3])] },
    'extra payload field': { ...PAYLOAD, video: true },
    'extra step field': at(1, { ...PAYLOAD.steps[1], selector: '#name' }),
    'a CSS selector': at(2, { action: 'click', target: { css: '#save' } }),
    'an unknown role': at(2, { action: 'click', target: { role: 'generic', name: 'Save' } }),
    'an unknown action': at(2, { action: 'press', target: { role: 'button', name: 'Save' } }),
    'a password label': at(1, { action: 'fill', target: { label: 'Password' }, value: 'x' }),
    'a sign-in button': at(2, { action: 'click', target: { role: 'button', name: 'Sign in' } }),
    'an API key field': at(1, { action: 'fill', target: { label: 'API key' }, value: 'x' }),
    'a token value': at(1, { action: 'fill', target: { label: 'Name' }, value: 'my token' }),
    'user info in a URL': at(0, { action: 'goto', url: 'http://user:pw@app.test/form' }),
    'a fragment': at(0, { action: 'goto', url: `${BASE}/form#x` }),
    'a token query': at(0, { action: 'goto', url: `${BASE}/form?access_token=abc` }),
    'a non-http URL': at(0, { action: 'goto', url: 'file:///etc/passwd' }),
    'a relative URL path check': at(5, { action: 'expectUrl', path: 'done' }),
    'an empty contains': at(4, { ...PAYLOAD.steps[4], contains: ' ' }),
    'a control character': at(1, { ...PAYLOAD.steps[1], value: 'a\u0000b' }),
  };
  for (const [why, p] of Object.entries(bad)) assert.equal(validWebPayload(p), false, why);
  assert.equal(underBase(`${BASE}/form`, BASE), true);
  assert.equal(underBase(`${BASE}/app/x`, `${BASE}/app/`), true);
  assert.equal(underBase(`${BASE}/apps`, `${BASE}/app`), false);
  assert.equal(underBase(`${BASE}/app/../outside`, `${BASE}/app`), false);
  assert.equal(underBase(`${BASE}/app/%2e%2e/outside`, `${BASE}/app`), false);
  assert.equal(underBase('http://other.test/form', BASE), false);
  assert.equal(webPayloadUnder(PAYLOAD, BASE), true);
  assert.equal(webPayloadUnder(PAYLOAD, `${BASE}/admin`), false);
  assert.deepEqual(webDescription(PAYLOAD), [{
    action: `open ${BASE}/form; fill label "Name" with "Ada"; click button "Save"`,
    assertion: 'heading "Saved" is visible; status "Greeting" contains "Hello Ada"; the URL path is "/done"',
  }]);
  // Actions after a check start a new step.
  assert.equal(webDescription({ steps: [...PAYLOAD.steps, { action: 'click', target: { role: 'link', name: 'Back' } }, { action: 'expectUrl', path: '/form' }] }).length, 2);
  assert.equal(webCandidateFits(PAYLOAD, S.name), true);
});

test('the fixed script carries the payload as data, and only a nonce-bound answer counts', () => {
  const nonce = 'ab'.repeat(16);
  const script = webScript({ steps: [{ action: 'goto', url: `${BASE}/'); process.exit(1); ('` }, PAYLOAD.steps[5]] }, nonce);
  assert.match(script, /const P = \{"steps":\[\{"action":"goto","url":"http:\/\/app\.test\/'\); process\.exit\(1\); \('"\}/);
  assert.equal(decodeWebAnswer(script, nonce), null, 'the echoed script is not an answer');
  const hex = s => [...s].map(c => c.codePointAt(0).toString(16).padStart(6, '0')).join('');
  const answer = v => `TOADWEB-${nonce}-${hex(JSON.stringify(v))}-END`;
  assert.deepEqual(decodeWebAnswer(`x ${answer({ result: 'PASS' })} y`, nonce), { result: 'PASS' });
  assert.deepEqual(decodeWebAnswer(answer({ result: 'FAIL', step: 4, message: 'é' }), nonce), { result: 'FAIL', step: 4, message: 'é' });
  assert.equal(decodeWebAnswer(answer({ result: 'PASS' }) + answer({ result: 'PASS' }), nonce), null, 'two answers are ambiguous');
  assert.equal(decodeWebAnswer(answer({ result: 'PASS' }), 'cd'.repeat(16)), null, 'another nonce is not this run');
  assert.equal(decodeWebAnswer(answer({ result: 'MAYBE' }), nonce), null);
});

test('a run drives the browser driver deterministically: pass, a changed expectation fails, unsafe and broken runs never pass', async t => {
  const fake = fakeEnv(t, APP('Hello'), { TOAD_PLAYWRIGHT_SECRETS_FILE: '/should/not/reach/the/browser' });
  assert.deepEqual(await runWebPayload(PAYLOAD, { env: fake.env }), { result: 'PASS' });
  const [call] = fake.calls();
  assert.equal(call.tool, 'browser_run_code_unsafe');
  assert.equal(call.env.secrets, '', 'the browser gets an empty secrets file, never the caller\'s');
  assert.equal(call.env.recording, null);

  const changed = { steps: PAYLOAD.steps.map((s, i) => (i === 4 ? { ...s, contains: 'Hello Grace' } : s)) };
  assert.deepEqual(await runWebPayload(changed, { env: fake.env }), { result: 'FAIL', step: 4, message: 'the assertion did not hold' });
  const missing = { steps: [PAYLOAD.steps[0], { action: 'click', target: { role: 'button', name: 'Gone' } }, PAYLOAD.steps[5]] };
  assert.equal((await runWebPayload(missing, { env: fake.env })).result, 'FAIL');
  const ambiguous = { steps: [PAYLOAD.steps[0], { action: 'click', target: { role: 'button', name: 'Twin' } }, PAYLOAD.steps[5]] };
  assert.equal((await runWebPayload(ambiguous, { env: fake.env })).result, 'FAIL', 'a locator must match exactly one element');
  const password = { steps: [PAYLOAD.steps[0], { action: 'fill', target: { label: 'Word' }, value: 'hunter2' }, PAYLOAD.steps[5]] };
  assert.equal((await runWebPayload(password, { env: fake.env })).result, 'UNSAFE', 'a password input is never filled');
  const down = { steps: [{ action: 'goto', url: 'http://app.test:1/form' }, PAYLOAD.steps[5]] };
  assert.equal((await runWebPayload(down, { env: fake.env })).result, 'ERROR');
  const notFound = { steps: [{ action: 'goto', url: `${BASE}/nope` }, PAYLOAD.steps[5]] };
  assert.equal((await runWebPayload(notFound, { env: fake.env })).result, 'FAIL');
  assert.equal((await runWebPayload(PAYLOAD, { env: { ...fake.env, FAKE_WEB_MODE: 'no-tool' } })).result, 'ERROR');
  assert.equal((await runWebPayload(PAYLOAD, { env: { ...fake.env, FAKE_WEB_MODE: 'silent' } })).result, 'ERROR', 'no answer is never a pass');
  assert.equal((await runWebPayload(PAYLOAD, { env: { ...fake.env, TOAD_WEB_DRIVER: JSON.stringify([join(fake.dir, 'missing')]) } })).result, 'ERROR');
  assert.equal((await runWebPayload({ steps: [] }, { env: fake.env })).result, 'ERROR');
});

/** Run the structured web tool as a web-tester would. */
function tool(env, request) {
  const r = spawnSync(process.execPath, [TOOL], { input: JSON.stringify(request), encoding: 'utf8', env, timeout: 60000 });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test('the structured web tool records a receipt, captures only a pass, and refuses credentials', t => {
  const root = temp(t, 'toad-web-tool-');
  const receipts = join(root, 'receipts');
  const folder = join(receipts, 'saves-a-name');
  writeFileSync(join(root, 'empty.env'), '\n');
  const fake = fakeEnv(t, APP('Hello'), { TOAD_RECEIPTS_DIR: receipts, TOAD_PLAYWRIGHT_SECRETS_FILE: join(root, 'empty.env'), TOAD_RECORDING_ENABLED: 'web-v1' });
  const capture = { scenarioName: S.name, complete: true };

  const pass = tool(fake.env, { receipts: folder, name: '01-structured', payload: PAYLOAD, capture });
  assert.equal(pass.code, 0, pass.err);
  assert.equal(pass.out.status, 'pass');
  assert.equal(pass.out.captured, true);
  assert.equal(readFileSync(pass.out.receipt, 'utf8'), webReceipt(PAYLOAD, { result: 'PASS' }));
  assert.deepEqual(JSON.parse(readFileSync(`${pass.out.receipt}.recording.json`, 'utf8')), { version: 1, scenarioName: S.name, payload: PAYLOAD });

  const again = tool(fake.env, { receipts: folder, name: '01-structured', payload: PAYLOAD, capture });
  assert.equal(again.code, 2);
  assert.match(again.out.error, /already exists/, 'a receipt is never overwritten');

  const changed = { steps: PAYLOAD.steps.map((s, i) => (i === 4 ? { ...s, contains: 'Hello Grace' } : s)) };
  const fail = tool(fake.env, { receipts: join(receipts, 'other'), name: '01-structured', payload: changed, capture });
  assert.equal(fail.code, 1);
  assert.equal(fail.out.status, 'fail');
  assert.equal(fail.out.step, 5);
  assert.equal(fail.out.captured, false);
  assert.match(readFileSync(fail.out.receipt, 'utf8'), /result: FAIL at step 5: the assertion did not hold\n$/);
  assert.equal(existsSync(`${fail.out.receipt}.recording.json`), false, 'a failed run leaves no candidate');

  const password = tool(fake.env, { receipts: join(receipts, 'pw'), name: '01-structured', capture, payload: { steps: [PAYLOAD.steps[0], { action: 'fill', target: { label: 'Word' }, value: 'x' }, PAYLOAD.steps[5]] } });
  assert.equal(password.code, 2);
  assert.match(password.out.error, /credential-like/);
  assert.equal(existsSync(`${password.out.receipt}.recording.json`), false);

  const off = tool({ ...fake.env, TOAD_RECORDING_ENABLED: '' }, { receipts: join(receipts, 'off'), name: '01-structured', payload: PAYLOAD, capture });
  assert.equal(off.out.status, 'pass');
  assert.equal(off.out.captured, false, 'no capture unless the run enables it');

  writeFileSync(join(root, 'secrets.env'), 'PASSWORD="private"\n');
  const secret = tool({ ...fake.env, TOAD_PLAYWRIGHT_SECRETS_FILE: join(root, 'secrets.env') }, { receipts: join(receipts, 'secret'), name: '01-structured', payload: PAYLOAD, capture });
  assert.equal(secret.code, 2);
  assert.equal(secret.out.error, 'credentials are not supported');
  assert.doesNotMatch(JSON.stringify(secret.out), /private/);
  assert.equal(existsSync(join(receipts, 'secret')), false, 'a refused run never reaches the browser');

  const signIn = tool(fake.env, { receipts: join(receipts, 'login'), name: '01-structured', payload: { steps: [PAYLOAD.steps[0], { action: 'click', target: { role: 'button', name: 'Log in' } }, PAYLOAD.steps[5]] } });
  assert.equal(signIn.code, 2);
  assert.match(signIn.out.error, /unsupported web scenario/);

  const outside = tool(fake.env, { receipts: join(root, 'elsewhere'), name: '01-structured', payload: PAYLOAD });
  assert.equal(outside.code, 2);
  assert.match(outside.out.error, /must be inside/);
  for (const request of [{ receipts: folder, name: '../x', payload: PAYLOAD }, { receipts: folder, name: 'x', payload: PAYLOAD, capture: { scenarioName: S.name, complete: false } }, { receipts: folder, name: 'x', payload: PAYLOAD, extra: 1 }]) {
    assert.equal(tool(fake.env, request).code, 2, JSON.stringify(request));
  }
  // pass, fail, password and capture-off; never a duplicate, refused or invalid request.
  assert.equal(fake.calls().length, 4, 'only valid, credential-free requests reached the browser');
});

test('the browser tool binds relative paths to the run target and rejects old-target navigation', t => {
  const root=temp(t,'toad-target-binding-');
  const receipts=join(root,'receipts');
  const empty=join(root,'empty.env');writeFileSync(empty,'');
  const fake=fakeEnv(t,APP('Hello'),{TOAD_RECEIPTS_DIR:receipts,TOAD_PLAYWRIGHT_SECRETS_FILE:empty,TOAD_WEB_TARGET_URL:'http://stage.test/'});
  const relative={steps:PAYLOAD.steps.map(s=>s.action==='goto'?{...s,url:'/form'}:s)};
  const result=tool(fake.env,{receipts,name:'relative',payload:relative});
  assert.equal(result.code,0,JSON.stringify(result));
  assert.match(fake.calls()[0].code,/http:\/\/stage\.test\/form/);
  const rejected=tool(fake.env,{receipts,name:'wrong-target',payload:PAYLOAD});
  assert.equal(rejected.code,2,'old-origin requests are refused before browser execution');
  assert.equal(fake.calls().length,1);
});

/** A finished run folder with one web scenario, its result, and the given receipts. */
function webRun(t, { result = 'PASS', handoff = {}, files = {} } = {}) {
  const run = temp(t, 'toad-web-run-');
  const h = { version: 1, kind: 'web', target: { url: BASE }, request: { goal: 'Check names', scenarios: [S] }, ...handoff };
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(h));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: S.name, result }] }));
  const folder = join(run, 'receipts', 'saves-a-name');
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  finalizeWebCandidates(run, h, [{ name: S.name, result }]);
  return run;
}
const candidate = (payload = PAYLOAD, scenarioName = S.name) => JSON.stringify({ version: 1, scenarioName, payload });
const passing = (payload = PAYLOAD) => ({ '01-structured.txt': webReceipt(payload, { result: 'PASS' }), '01-structured.txt.recording.json': candidate(payload) });

test('only a passing, credential-free, unambiguous structured run is finalized', t => {
  const ok = webRun(t, { files: { ...passing(), '01-home.png': 'png' } });
  assert.deepEqual(recordingStatus(ok, 'web', S), { status: 'recorded', steps: webDescription(PAYLOAD) });

  const notRecorded = (why, options) => assert.deepEqual(recordingStatus(webRun(t, options), 'web', S), { status: 'not-captured' }, why);
  notRecorded('failed scenario', { result: 'FAIL', files: passing() });
  notRecorded('errored scenario', { result: 'ERROR', files: passing() });
  notRecorded('credentials', { handoff: { credentials: { password: { env: 'PASSWORD' } } }, files: passing() });
  notRecorded('a second structured receipt', { files: { ...passing(), '02-structured.txt': webReceipt(PAYLOAD, { result: 'FAIL', step: 1, message: 'x' }) } });
  notRecorded('two candidates', { files: { ...passing(), '02-structured.txt': webReceipt(PAYLOAD, { result: 'PASS' }), '02-structured.txt.recording.json': candidate() } });
  notRecorded('a failing receipt', { files: { '01-structured.txt': webReceipt(PAYLOAD, { result: 'FAIL', step: 4, message: 'the assertion did not hold' }), '01-structured.txt.recording.json': candidate() } });
  notRecorded('a receipt for other steps', { files: { '01-structured.txt': webReceipt({ steps: PAYLOAD.steps.slice(0, 4) }, { result: 'PASS' }), '01-structured.txt.recording.json': candidate() } });
  notRecorded('no receipt', { files: { '01-structured.txt.recording.json': candidate() } });
  notRecorded('another scenario name', { files: { ...passing(), '01-structured.txt.recording.json': candidate(PAYLOAD, 'Other') } });
  const offBase = { steps: [{ action: 'goto', url: 'http://other.test/form' }, ...PAYLOAD.steps.slice(1)] };
  notRecorded('a navigation off the target', { files: passing(offBase) });
  const sensitive = { steps: [PAYLOAD.steps[0], { action: 'fill', target: { label: 'Password' }, value: 'x' }, PAYLOAD.steps[5]] };
  notRecorded('a credential-like field', { files: passing(sensitive) });
  // The intent changed after capture: the recording is stale, not shown.
  assert.deepEqual(recordingStatus(ok, 'web', { ...S, expected: 'Something else.' }), { status: 'not-captured' });
});

/** A project with a web suite and, optionally, its saved recording. */
function project(t, { recording = PAYLOAD } = {}) {
  const dir = temp(t, 'toad-web-project-');
  mkdirSync(join(dir, '.toad', 'suites', 'web.recordings'), { recursive: true });
  mkdirSync(join(dir, '.toad', 'runs'));
  writeFileSync(join(dir, '.toad', '.gitignore'), '.env\nruns/\n');
  writeFileSync(join(dir, '.toad', 'toad.yaml'), '');
  writeFileSync(join(dir, '.toad', 'suites', 'web.yaml'), `kind: web\ntarget: { url: '${BASE}' }\ngoal: Check names.\nscenarios:\n  - name: ${S.name}\n    steps: ${S.steps}\n    expected: ${S.expected}\n`);
  if (recording) writeFileSync(join(dir, '.toad', 'suites', 'web.recordings', `${scenarioId(S.name)}.json`), JSON.stringify(envelope(S, recording)) + '\n');
  return dir;
}

/** A stand-in agent whose tester passes or fails, and may capture as cli_run_structured_web would. */
function agent(t, { result = 'PASS', capture } = {}) {
  const dir = temp(t, 'toad-web-agent-');
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'system.yaml'), 'orchestrator:\n  name: lead\n  model: deepseek/deepseek-flash\nagents:\n  - name: web-tester\n    model: deepseek/deepseek-flash\n');
  mkdirSync(join(dir, dirname(COMMANDS)), { recursive: true });
  writeFileSync(join(dir, COMMANDS), '{}');
  writeFileSync(join(dir, 'fake-pi.mjs'), `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import { webReceipt } from ${JSON.stringify(RECORDING)};
import { fakeWebEvidence } from ${JSON.stringify(new URL('./fake-web-evidence.mjs', import.meta.url).href)};
const pre = process.argv.slice(2);
const prompt = pre[pre.indexOf('-p') + 1];
fs.appendFileSync('requests', JSON.stringify({ request: prompt, recording: process.env.TOAD_RECORDING_ENABLED ?? null }) + '\\n');
const capture = ${JSON.stringify(capture ?? null)};
if (capture && ${JSON.stringify(result)} === 'PASS') {
  const dir = path.join(process.env.TOAD_RECEIPTS_DIR, 'saves-a-name'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01-structured.txt'), webReceipt(capture, { result: 'PASS' }));
  fs.writeFileSync(path.join(dir, '01-structured.txt.recording.json'), JSON.stringify({ version: 1, scenarioName: ${JSON.stringify(S.name)}, payload: capture }));
}
const text = ['Verdict: ${result}', 'Results:', '- ${result} | ${S.name}'].join('\\n');
fakeWebEvidence(process.env, text);
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] }));
`, { mode: 0o755 });
  return dir;
}
const requests = agentDir => existsSync(join(agentDir, 'requests')) ? readFileSync(join(agentDir, 'requests'), 'utf8').trim().split('\n').map(JSON.parse) : [];

function toad(t, args, { cwd, env, agentDir, key = 'test-key' }) {
  const home = temp(t, 'toad-home-');
  // A browser is "installed", so toad run never downloads one here.
  mkdirSync(join(home, 'browsers', 'chromium-0'), { recursive: true });
  const result = spawnSync(process.execPath, [CLI, 'run', ...args], { cwd, encoding: 'utf8', timeout: 120000, env: {
    ...env, TOAD_AGENT_DIR: agentDir ?? join(home, 'no-agent-here'), TOAD_PI: agentDir ? join(agentDir, 'fake-pi.mjs') : '', PLAYWRIGHT_BROWSERS_PATH: join(home, 'browsers'),
    TOAD_CONFIG_DIR: join(home, 'config'), TOAD_CACHE_DIR: join(home, 'cache'), TOAD_RUNTIME_DIR: join(home, 'runtime'), DEEPSEEK_API_KEY: key,
  } });
  return { code: result.status, err: result.stderr, report: result.stdout ? JSON.parse(result.stdout) : null };
}

test('a saved web recording replays in a fresh browser, with no agent, model key or model call', t => {
  const dir = project(t);
  const fake = fakeEnv(t);
  const r = toad(t, ['--json'], { cwd: dir, env: fake.env, key: '' });
  assert.equal(r.code, 0, r.err);
  const [s] = r.report.suites[0].scenarios;
  assert.equal(s.mode, 'replay');
  assert.deepEqual(s.attempts, ['PASS']);
  assert.deepEqual(r.report.modes, { replay: 1, agent: 0, healed: 0 });
  const folder = join(dir, r.report.suites[0].runs[0].folder);
  assert.equal(readFileSync(join(folder, 'receipts', 'saves-a-name', '01-replay.txt'), 'utf8'), webReceipt(PAYLOAD, { result: 'PASS' }));
  assert.equal(recordingStatus(folder, 'web', S).status, 'recorded', 'the replay run shows the recording');
  assert.equal(fake.calls().length, 1);
  assert.equal(fake.calls()[0].env.secrets, '');

  // --url moves every navigation under the suite's URL; the original host is never visited.
  const moved = toad(t, ['--json', '--url', 'http://staging.test'], { cwd: dir, env: fake.env, key: '' });
  assert.equal(moved.code, 0, moved.err);
  assert.equal(moved.report.suites[0].scenarios[0].mode, 'replay');
  const code = fake.calls()[1].code;
  assert.match(code, /"url":"http:\/\/staging\.test\/form"/);
  assert.doesNotMatch(code, /app\.test/);
});

test('a changed page fails the replay, and the agent decides: a regression, or a healed recording', t => {
  const dir = project(t);
  const fake = fakeEnv(t, APP('Hi'));
  const before = readFileSync(join(dir, '.toad', 'suites', 'web.recordings', `${scenarioId(S.name)}.json`), 'utf8');

  const failing = agent(t, { result: 'FAIL' });
  const regression = toad(t, ['--json', '--retries', '0'], { cwd: dir, env: fake.env, agentDir: failing });
  assert.equal(regression.code, 1, regression.err);
  const [r] = regression.report.suites[0].scenarios;
  assert.equal(r.result, 'FAIL');
  assert.equal(r.replay, 'FAIL');
  assert.equal(r.proposed, undefined, 'a failed scenario proposes nothing');
  const [request] = requests(failing);
  assert.equal(request.recording, 'web-v1', 'a credential-free web run enables capture');
  assert.match(request.request, /cli_run_structured_web/);

  const healed = { steps: PAYLOAD.steps.map((s, i) => (i === 4 ? { ...s, contains: 'Hi Ada' } : s)) };
  const healer = agent(t, { capture: healed });
  const h = toad(t, ['--json', '--retries', '0'], { cwd: dir, env: fake.env, agentDir: healer });
  assert.equal(h.code, 0, h.err);
  const [s] = h.report.suites[0].scenarios;
  assert.equal(s.mode, 'healed');
  assert.deepEqual(s.proposed.diff, [
    `- ${webDescription(PAYLOAD)[0].action} => ${webDescription(PAYLOAD)[0].assertion}`,
    `+ ${webDescription(healed)[0].action} => ${webDescription(healed)[0].assertion}`,
  ]);
  assert.equal(readFileSync(join(dir, '.toad', 'suites', 'web.recordings', `${scenarioId(S.name)}.json`), 'utf8'), before, 'the saved recording is untouched');

  const accept = spawnSync(process.execPath, [CLI, ...s.proposed.accept.split(' ').slice(1)], { cwd: dir, encoding: 'utf8', env: { ...fake.env, TOAD_CONFIG_DIR: temp(t, 'toad-cfg-') } });
  assert.equal(accept.status, 0, accept.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.toad', 'suites', 'web.recordings', `${scenarioId(S.name)}.json`), 'utf8')).payload, healed);
  const next = toad(t, ['--json'], { cwd: dir, env: fake.env, key: '' });
  assert.equal(next.code, 0, next.err);
  assert.equal(next.report.suites[0].scenarios[0].mode, 'replay', 'the healed recording now replays');
});

test('URL override never lets agent fallback report PASS after following an old absolute target', t => {
  const dir = project(t, {recording: null});
  const suite = join(dir, '.toad', 'suites', 'web.yaml');
  const absolute = {...S, steps: `Open ${BASE}/form, enter Ada and save.`};
  writeFileSync(suite, `kind: web\ntarget: { url: '${BASE}' }\ngoal: Check names.\nscenarios:\n  - name: ${absolute.name}\n    steps: ${absolute.steps}\n    expected: ${absolute.expected}\n`);
  writeFileSync(join(dir, '.toad', 'suites', 'web.recordings', `${scenarioId(S.name)}.json`), JSON.stringify(envelope(absolute, PAYLOAD))+'\n');
  const tester = agent(t, {result:'PASS'});
  const result = toad(t, ['--json','--retries','0','--url','http://staging.test'], {cwd:dir, env:fakeEnv(t, APP('Hi')).env, agentDir:tester});
  assert.notEqual(result.code, 0, 'never report a pass against the old target');
  assert.equal(result.report.suites[0].scenarios[0].result, 'ERROR');
  assert.equal(result.report.suites[0].scenarios[0].mode, 'replay');
  assert.equal(requests(tester).length, 0, 'ambiguous fallback is blocked');
});

test('web replay choices: off-target recordings and credentialed suites go to the agent; an unreachable page is an ERROR', t => {
  const dir = project(t);
  const folder = join(dir, '.toad');
  const [suite] = readSuites(folder);
  const config = readProjectConfig(folder);
  assert.equal(replayChoices(dir, suite, config, suite.scenarios)[0].mode, 'replay');
  assert.match(replayChoices(dir, { ...suite, target: { url: `${BASE}/admin` } }, config, suite.scenarios)[0].reason, /no longer supported|not under/);
  assert.match(replayChoices(dir, { ...suite, credentials: { password: { env: 'PASSWORD' } } }, config, suite.scenarios)[0].reason, /no longer supported/);

  const down = project(t, { recording: { steps: [{ action: 'goto', url: 'http://app.test:1/form' }, PAYLOAD.steps[5]] } });
  writeFileSync(join(down, '.toad', 'suites', 'web.yaml'), readFileSync(join(down, '.toad', 'suites', 'web.yaml'), 'utf8').replace(`'${BASE}'`, "'http://app.test:1'"));
  const r = toad(t, ['--json', '--retries', '0'], { cwd: down, env: fakeEnv(t).env, key: '' });
  assert.equal(r.code, 2, r.err);
  assert.equal(r.report.suites[0].scenarios[0].result, 'ERROR');
  assert.match(r.report.suites[0].scenarios[0].message, /replay could not run/);
});

test('saving a web run as a suite copies its valid recording', t => {
  const dir = project(t, { recording: null });
  const id = '2026-11-09T10-00-00-000Z-web';
  const run = join(dir, '.toad', 'runs', id);
  mkdirSync(join(run, 'receipts', 'saves-a-name'), { recursive: true });
  const h = { version: 1, kind: 'web', target: { url: BASE }, request: { goal: 'Check names', scenarios: [S] } };
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(h));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: S.name, result: 'PASS' }] }));
  for (const [name, text] of Object.entries(passing())) writeFileSync(join(run, 'receipts', 'saves-a-name', name), text);
  finalizeWebCandidates(run, h, [{ name: S.name, result: 'PASS' }]);
  const saved = saveSuiteFromRun(dir, id, 'kept', { cwd: dir });
  assert.deepEqual(saved.scenarios, [{ name: S.name, recording: 'recorded' }]);
  assert.deepEqual(readdirSync(saved.recordings), [`${scenarioId(S.name)}.json`]);
  assert.deepEqual(JSON.parse(readFileSync(join(saved.recordings, `${scenarioId(S.name)}.json`), 'utf8')).payload, PAYLOAD);
});

// The real thing: the agent's pinned Playwright MCP and browser, against a local page.
test('a real browser passes the recorded steps and fails a changed expectation', { timeout: 600000, skip: process.env.TOAD_TEST_NO_BROWSER === '1' || !browserInstalled() ? 'no browser installed (toad setup installs one)' : false }, async t => {
  let externalRequests = 0;
  const external = createServer((_req, res) => { externalRequests++; res.end('outside'); });
  await new Promise(r => external.listen(0, '127.0.0.1', r));
  t.after(() => external.close());
  const outside = `http://127.0.0.1:${external.address().port}/outside`;
  const pages = {
    '/external': `<!doctype html><a href="${outside}">Leave</a>`,
    '/scope/form': '<!doctype html><a href="/outside-scope">Leave scope</a>',
    '/form': '<!doctype html><title>Form</title><label for="n">Name</label><input id="n"><label for="w">Word</label><input id="w" type="password"><button onclick="location.href=\'/done?name=\'+encodeURIComponent(document.getElementById(\'n\').value)">Save</button>',
    '/done': '<!doctype html><title>Done</title><h1>Saved</h1><p role="status" aria-label="Greeting" id="g"></p><script>document.getElementById("g").textContent="Hello "+new URLSearchParams(location.search).get("name")</script>',
  };
  let scopeEscapes = 0;
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/outside-scope') scopeEscapes++;
    const page = pages[new URL(req.url, 'http://x').pathname];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' }); res.end(page ?? 'missing');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  for (const k of ['TOAD_WEB_DRIVER', 'TOAD_PLAYWRIGHT_SECRETS_FILE', 'TOAD_RECEIPTS_DIR']) delete env[k];
  const steps = [
    { action: 'goto', url: `${base}/form` },
    { action: 'fill', target: { label: 'Name' }, value: 'Ada' },
    { action: 'click', target: { role: 'button', name: 'Save' } },
    { action: 'expectVisible', target: { role: 'heading', name: 'Saved' } },
    { action: 'expectText', target: { role: 'status', name: 'Greeting' }, contains: 'Hello Ada' },
    { action: 'expectUrl', path: '/done?name=Ada' },
  ];
  const screenshots = temp(t, 'toad-web-screenshots-');
  const passShot = join(screenshots, 'pass.png');
  assert.deepEqual(await runWebPayload({ steps }, { env, screenshot: passShot }), { result: 'PASS' });
  assert.equal(readFileSync(passShot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const changed = steps.map((s, i) => (i === 4 ? { ...s, contains: 'Hello Grace' } : s));
  const failShot = join(screenshots, 'fail.png');
  assert.deepEqual(await runWebPayload({ steps: changed }, { env: { ...env, TOAD_WEB_STEP_TIMEOUT_MS: '1500' }, screenshot: failShot }), { result: 'FAIL', step: 4, message: 'the assertion did not hold' });
  assert.equal(readFileSync(failShot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const password = [steps[0], { action: 'fill', target: { label: 'Word' }, value: 'x' }, steps[3]];
  assert.equal((await runWebPayload({ steps: password }, { env })).result, 'UNSAFE');
  const escape = [{ action:'goto', url:`${base}/external` }, {action:'click', target:{role:'link',name:'Leave'}}, {action:'expectText',target:{role:'link',name:'Leave'},contains:'Leave'}];
  await runWebPayload({steps:escape}, {env:{...env, TOAD_WEB_STEP_TIMEOUT_MS:'500'}});
  assert.equal(externalRequests, 0, 'cross-origin navigation is blocked before the request');
  const scoped={steps:[{action:'goto',url:`${base}/scope/form`},{action:'click',target:{role:'link',name:'Leave scope'}},{action:'expectUrl',path:'/outside-scope'}]};
  const blocked=await runWebPayload(scoped,{env:{...env,TOAD_WEB_STEP_TIMEOUT_MS:'500'},targetUrl:`${base}/scope`});
  assert.notEqual(blocked.result,'PASS');
  assert.equal(scopeEscapes,0,'same-origin clicks cannot escape the effective target path prefix');
});
