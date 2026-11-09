import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { intentHash, scenarioId } from '../recordings.mjs';
import { readProjectConfig, readSuites } from '../projects.mjs';
import { parseAcceptArgs, rebaseUrl, replayChoices, stepsDiff } from '../replay.mjs';
import { parseRunArgs } from '../toad-run.mjs';

const tmpdir = () => realpathSync(osTmpdir());
const CLI = resolve(import.meta.dirname, '../cli.mjs');
const COMMANDS = '.pi/git/github.com/mihaiiova/pi-commands/package.json';

const A = { name: 'Prints ready', steps: 'Run ./check.', expected: 'It prints ready.' };
const B = { name: 'Prints version', steps: 'Run ./check --version.', expected: 'It prints a version.' };
const C = { name: 'Shows help', steps: 'Run ./check --help.', expected: 'It prints usage.' };
const D = { name: 'Lists items', steps: 'Run ./check list.', expected: 'It lists items.' };
const E = { name: 'Counts items', steps: 'Run ./check count.', expected: 'It counts items.' };
const READY = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };
const READY_V2 = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready v2\n' } } };

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const envelope = (kind, scenario, payload) => ({
  version: 1, status: 'recorded', kind, scenarioId: scenarioId(scenario.name), intentHash: intentHash(kind, scenario),
  codec: kind === 'api' ? 'api-request-v1' : 'cli-command-v1', payload,
});

/**
 * A stand-in agent, as in toad-run.test.mjs: a fake `pi` answering each
 * scenario from behaviour.json { results: { name: [..] }, capture: { name:
 * payload } }. A captured scenario leaves a structured-command receipt and
 * candidate, as cli_run_structured_command would, so Toad records it.
 */
function agent(t, behaviour) {
  const dir = temp(t, 'toad-agent-');
  writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(behaviour));
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'system.yaml'), 'orchestrator:\n  name: lead\n  model: deepseek/deepseek-flash\nagents:\n  - name: cli-tester\n    model: deepseek/deepseek-flash\n');
  mkdirSync(join(dir, dirname(COMMANDS)), { recursive: true });
  writeFileSync(join(dir, COMMANDS), '{}');
  writeFileSync(join(dir, 'fake-pi.mjs'), `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const pre = process.argv.slice(2);
const prompt = pre[pre.indexOf('-p') + 1];
const b = JSON.parse(fs.readFileSync('behaviour.json', 'utf8'));
const request = prompt.slice(prompt.indexOf('\\n\\n') + 2);
fs.appendFileSync('requests', JSON.stringify({ request }) + '\\n');
const names = [...request.matchAll(/^\\d+\\. "(.+?)":/gm)].map(m => m[1]);
const counts = fs.existsSync('counts.json') ? JSON.parse(fs.readFileSync('counts.json', 'utf8')) : {};
const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const q = v => "'" + v.replaceAll("'", "'\\\\''") + "'";
const lines = names.map(name => {
  const i = counts[name] = (counts[name] ?? -1) + 1; const list = b.results?.[name] ?? ['PASS'];
  const result = list[Math.min(i, list.length - 1)];
  const p = b.capture?.[name];
  if (p && result === 'PASS') {
    const dir = path.join(process.env.TOAD_RECEIPTS_DIR, slug(name)); fs.mkdirSync(dir, { recursive: true });
    const out = p.expect.stdout.equals ?? p.expect.stdout.contains;
    fs.writeFileSync(path.join(dir, '01-check.txt'), ['$ exec ' + [p.program, ...p.args].map(q).join(' '), 'scenario: x', 'workspace: w', 'sandbox: none', 'result: exit ' + p.expect.exitCode, 'duration: 0.1s', '--- stdout ---', out, '--- stderr ---', ''].join('\\n'));
    fs.writeFileSync(path.join(dir, '01-check.txt.recording.json'), JSON.stringify({ version: 1, scenarioName: name, payload: p }));
  }
  return '- ' + result + ' | ' + name;
});
fs.writeFileSync('counts.json', JSON.stringify(counts));
const verdict = lines.some(l => l.includes('FAIL')) ? 'FAIL' : lines.some(l => l.includes('ERROR')) ? 'ERROR' : 'PASS';
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: ['Verdict: ' + verdict, 'Results:', ...lines].join('\\n') }] }] }));
`, { mode: 0o755 });
  return dir;
}

const requests = agentDir => existsSync(join(agentDir, 'requests')) ? readFileSync(join(agentDir, 'requests'), 'utf8').trim().split('\n').map(JSON.parse) : [];

const suiteYaml = (scenarios, extra = '') => `kind: cli
target: { workdir: ., program: ./check }
goal: Check the tool.
${extra}scenarios:
${scenarios.map(s => `  - name: ${s.name}\n    steps: ${s.steps}\n    expected: ${s.expected}${s.tags ? `\n    tags: [${s.tags.join(', ')}]` : ''}`).join('\n')}
`;

/** A project whose ./check prints `output`, with the smoke suite and its saved recordings. */
function project(t, { scenarios = [A], recordings = { [A.name]: READY }, output = 'ready', extra = '' } = {}) {
  const dir = temp(t, 'toad-replay-project-');
  mkdirSync(join(dir, '.toad', 'suites', 'smoke.recordings'), { recursive: true });
  writeFileSync(join(dir, '.toad', '.gitignore'), '.env\nruns/\n');
  writeFileSync(join(dir, '.toad', 'toad.yaml'), '');
  writeFileSync(join(dir, '.toad', 'suites', 'smoke.yaml'), suiteYaml(scenarios, extra));
  writeCheck(dir, output);
  for (const [name, payload] of Object.entries(recordings)) {
    const scenario = scenarios.find(s => s.name === name);
    writeFileSync(join(dir, '.toad', 'suites', 'smoke.recordings', `${scenarioId(name)}.json`), JSON.stringify(envelope('cli', scenario, payload)) + '\n');
  }
  return dir;
}
function writeCheck(dir, output) {
  writeFileSync(join(dir, 'check'), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(join(dir, 'check'), 0o755);
}
const savedFile = (dir, scenario, suite = 'smoke') => join(dir, '.toad', 'suites', `${suite}.recordings`, `${scenarioId(scenario.name)}.json`);

function env(t, agentDir, extra = {}) {
  const home = temp(t, 'toad-home-');
  return { ...process.env, TOAD_AGENT_DIR: agentDir, TOAD_PI: join(agentDir, 'fake-pi.mjs'), TOAD_CONFIG_DIR: join(home, 'config'), TOAD_CACHE_DIR: join(home, 'cache'), TOAD_RUNTIME_DIR: join(home, 'runtime'), DEEPSEEK_API_KEY: 'test-key', ...extra };
}
function toad(t, args, { cwd, agentDir, extra }) {
  const result = spawnSync(process.execPath, [CLI, 'run', '--sandbox', 'none', ...args], { cwd, encoding: 'utf8', timeout: 120000, env: env(t, agentDir, extra) });
  return { code: result.status, out: result.stdout, err: result.stderr, report: args.includes('--json') && result.stdout ? JSON.parse(result.stdout) : null };
}
/** The same, without blocking this process: the API tests serve HTTP from it. */
function toadAsync(t, args, { cwd, agentDir, extra }) {
  const environment = env(t, agentDir, extra);
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, 'run', '--sandbox', 'none', ...args], { cwd, env: environment });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => done({ code, out, err, report: out ? JSON.parse(out) : null }));
  });
}
// No agent at all, and no key: a replay-only run must need neither.
const NO_MODEL = dir => ({ TOAD_AGENT_DIR: join(dir, 'no-agent-here'), DEEPSEEK_API_KEY: '' });

test('run options parse --no-replay and --update-recordings, and accept arguments validate', () => {
  assert.equal(parseRunArgs([]).replay, true);
  assert.equal(parseRunArgs([]).updateRecordings, false);
  const o = parseRunArgs(['--no-replay', '--update-recordings']);
  assert.equal(o.replay, false);
  assert.equal(o.updateRecordings, true);
  assert.throws(() => parseRunArgs(['--no-replay=1']));
  assert.deepEqual(parseAcceptArgs(['run-1', '--suite', 'smoke']), { suite: 'smoke', run: 'run-1' });
  for (const bad of [[], ['run-1'], ['a', 'b', '--suite', 's'], ['run-1', '--suite'], ['run-1', '--suite', 's', '--nope']]) assert.throws(() => parseAcceptArgs(bad), undefined, bad.join(' '));
});

test('URLs rebase only under whole path segments, and steps diff line by line', () => {
  assert.equal(rebaseUrl('http://a.test/v1/health', 'http://a.test/v1', 'https://b.test/api/'), 'https://b.test/api/health');
  assert.equal(rebaseUrl('http://a.test/v1', 'http://a.test/v1/', 'https://b.test'), 'https://b.test');
  assert.equal(rebaseUrl('http://a.test/v1?x=1', 'http://a.test/v1', 'https://b.test'), 'https://b.test?x=1');
  assert.equal(rebaseUrl('http://a.test/v10/health', 'http://a.test/v1', 'https://b.test'), null);
  assert.equal(rebaseUrl('http://other.test/v1/health', 'http://a.test/v1', 'https://b.test'), null);
  assert.equal(rebaseUrl('http://a.test/x', 'http://a.test', 'not a url'), null);
  assert.deepEqual(stepsDiff([{ action: 'a', assertion: '1' }], [{ action: 'a', assertion: '2' }]), ['- a => 1', '+ a => 2']);
  assert.deepEqual(stepsDiff(null, [{ action: 'a', assertion: '2' }]), ['+ a => 2']);
});

test('only a valid, supported saved recording is replayed; the rest go to the agent with a reason', t => {
  const dir = project(t, { scenarios: [A, B, C], recordings: { [A.name]: READY, [B.name]: READY } });
  // B's intent changed after it was recorded.
  writeFileSync(join(dir, '.toad', 'suites', 'smoke.yaml'), suiteYaml([A, { ...B, expected: 'It prints 2.0.' }, C]));
  const folder = join(dir, '.toad');
  const [suite] = readSuites(folder);
  const config = readProjectConfig(folder);
  const modes = list => list.map(c => [c.mode, c.reason ?? '']);
  assert.deepEqual(modes(replayChoices(dir, suite, config, suite.scenarios)), [
    ['replay', ''], ['agent', 'the saved recording is stale (steps or expected changed)'], ['agent', 'no saved recording']]);
  assert.deepEqual(replayChoices(dir, suite, config, suite.scenarios)[0].envelope.payload, READY);
  assert.deepEqual(modes(replayChoices(dir, suite, config, suite.scenarios, { replay: false }))[0], ['agent', 'replay is off (--no-replay)']);
  // A suite that now takes credentials is outside the codec: never replayed with them.
  const withCredentials = { ...suite, credentials: { token: { env: 'API_TOKEN' } } };
  assert.match(replayChoices(dir, withCredentials, config, suite.scenarios)[0].reason, /no longer supported/);
  assert.equal(replayChoices(dir, { ...suite, kind: 'web' }, config, suite.scenarios)[0].mode, 'agent');
});

test('a replay-only run passes with no agent, no model key and no model call', t => {
  const agentDir = agent(t, {});
  const dir = project(t);
  const r = toad(t, ['--json', '--junit', 'out/junit.xml', '--summary', 'out/summary.md'], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.report.verdict, 'PASS');
  const [s] = r.report.suites[0].scenarios;
  assert.equal(s.mode, 'replay');
  assert.deepEqual(s.attempts, ['PASS']);
  assert.deepEqual(r.report.modes, { replay: 1, agent: 0, healed: 0 });
  assert.equal(r.report.cost, undefined, 'nothing was spent');
  assert.deepEqual(requests(agentDir), [], 'the agent never ran');
  assert.doesNotMatch(r.err, /Preparing the testing agent/);
  const [run] = r.report.suites[0].runs;
  assert.equal(run.replay, true);
  const folder = join(dir, run.folder);
  const state = JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8'));
  assert.equal(state.origin, 'cli');
  assert.equal(state.verdict, 'PASS');
  assert.deepEqual(state.replay.modes, { [A.name]: 'replay' });
  assert.match(readFileSync(join(folder, 'receipts', 'prints-ready', '01-replay.txt'), 'utf8'), /^\$ exec '\.\/check'\n[\s\S]*result: exit 0/);
  assert.match(readFileSync(join(folder, 'reports', 'report.md'), 'utf8'), /without a model[\s\S]*- PASS \| Prints ready/);
  assert.ok(existsSync(join(folder, 'recording', `${scenarioId(A.name)}.json`)), 'the run shows the replayed recording');
  assert.match(readFileSync(join(dir, 'out', 'junit.xml'), 'utf8'), /<property name="toad.mode" value="replay"\/>/);
  assert.match(readFileSync(join(dir, 'out', 'summary.md'), 'utf8'), /Modes: 1 replayed, 0 by the agent/);

  // --max-cost still reports what was spent: nothing.
  const capped = toad(t, ['--json', '--max-cost', '0'], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
  assert.equal(capped.code, 0, capped.err);
  assert.equal(capped.report.cost, 0);
});

test('a regression fails: the replay fails, the agent fails it too, and the saved recording stays', t => {
  const agentDir = agent(t, { results: { [A.name]: ['FAIL'] } });
  const dir = project(t, { output: 'broken' });
  const before = readFileSync(savedFile(dir, A), 'utf8');
  const r = toad(t, ['--json'], { cwd: dir, agentDir });
  assert.equal(r.code, 1, r.err);
  const [s] = r.report.suites[0].scenarios;
  assert.equal(s.result, 'FAIL');
  assert.equal(s.replay, 'FAIL');
  assert.equal(s.mode, 'agent');
  assert.deepEqual(s.attempts, ['FAIL', 'FAIL'], 'the agent ran, and retried, as before');
  assert.equal(s.proposed, undefined);
  assert.equal(requests(agentDir).length, 2);
  assert.deepEqual(r.report.suites[0].runs.map(x => !!x.replay), [true, false, false]);
  assert.equal(readFileSync(savedFile(dir, A), 'utf8'), before);

  // Without a key, a failed replay cannot be checked: an ERROR, never a silent pass or a guess.
  const noKey = toad(t, ['--json'], { cwd: dir, agentDir, extra: { DEEPSEEK_API_KEY: '' } });
  assert.equal(noKey.code, 3, noKey.err);
  assert.equal(noKey.report.suites[0].scenarios[0].result, 'ERROR');
  assert.match(noKey.report.suites[0].scenarios[0].message, /assertion failed, and the agent could not check.*no key for deepseek/);
});

test('healing: a failed replay the agent passes proposes a new recording; accepting it writes the suite', t => {
  const agentDir = agent(t, { capture: { [A.name]: READY_V2 } });
  const dir = project(t, { output: 'ready v2' });
  const before = readFileSync(savedFile(dir, A), 'utf8');
  const r = toad(t, ['--json', '--junit', 'junit.xml', '--summary', 'summary.md'], { cwd: dir, agentDir });
  assert.equal(r.code, 0, r.err);
  const [s] = r.report.suites[0].scenarios;
  assert.equal(s.result, 'PASS');
  assert.equal(s.mode, 'healed');
  assert.deepEqual(s.attempts, ['PASS'], 'a healed pass is a pass, not flaky');
  assert.deepEqual(r.report.modes, { replay: 0, agent: 0, healed: 1 });
  assert.equal(r.report.proposed, 1);
  assert.deepEqual(s.proposed.diff, ['- ./check => exit 0; stdout {"equals":"ready\\n"}', '+ ./check => exit 0; stdout {"equals":"ready v2\\n"}']);
  assert.ok(existsSync(join(dir, s.proposed.recording)), 'the proposal stays in the run folder');
  assert.match(s.proposed.accept, /^toad suites accept \S+ --suite smoke$/);
  assert.match(r.report.notes.join(' '), /saved ones are unchanged.*toad suites accept/);
  assert.equal(readFileSync(savedFile(dir, A), 'utf8'), before, 'the saved recording is untouched');
  assert.match(readFileSync(join(dir, 'junit.xml'), 'utf8'), /value="healed"\/><property name="toad.proposed" value="true"\/>/);
  assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /1 healed · 1 proposed recording/);
  const agentRun = join(dir, s.proposed.run);
  const state = JSON.parse(readFileSync(join(agentRun, 'state.json'), 'utf8'));
  assert.equal(state.replay.modes[A.name], 'healed');
  assert.deepEqual(state.replay.proposed[A.name].diff, s.proposed.diff);
  assert.equal(state.replay.accept, s.proposed.accept);

  const accept = spawnSync(process.execPath, [CLI, ...s.proposed.accept.split(' ').slice(1)], { cwd: dir, encoding: 'utf8', env: env(t, agentDir) });
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(accept.stdout, /Accepted 1 recording into \.toad\/suites\/smoke\.recordings/);
  assert.match(accept.stdout, /\+ \.\/check => exit 0; stdout \{"equals":"ready v2\\n"\}/);
  assert.deepEqual(JSON.parse(readFileSync(savedFile(dir, A), 'utf8')).payload, READY_V2);
  assert.deepEqual(readdirSync(join(dir, '.toad', 'suites', 'smoke.recordings')), [`${scenarioId(A.name)}.json`], 'no temporary file is left');
  const again = spawnSync(process.execPath, [CLI, ...s.proposed.accept.split(' ').slice(1)], { cwd: dir, encoding: 'utf8', env: env(t, agentDir) });
  assert.match(again.stdout, /Nothing to accept/);

  // The accepted recording now replays, without a model.
  const next = toad(t, ['--json'], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
  assert.equal(next.code, 0, next.err);
  assert.equal(next.report.suites[0].scenarios[0].mode, 'replay');
});

test('--update-recordings writes the healed recording into the suite; --no-replay always uses the agent', t => {
  const agentDir = agent(t, { capture: { [A.name]: READY_V2 } });
  const dir = project(t, { output: 'ready v2' });
  const r = toad(t, ['--json', '--update-recordings'], { cwd: dir, agentDir });
  assert.equal(r.code, 0, r.err);
  const [s] = r.report.suites[0].scenarios;
  assert.equal(s.mode, 'healed');
  assert.equal(s.proposed.updated, `.toad/suites/smoke.recordings/${scenarioId(A.name)}.json`);
  assert.equal(s.proposed.accept, undefined);
  assert.deepEqual(JSON.parse(readFileSync(savedFile(dir, A), 'utf8')).payload, READY_V2);
  assert.match(r.report.notes.join(' '), /Updated 1 saved recording/);

  // --no-replay: the agent runs even with a valid recording, and an identical capture proposes nothing.
  const before = requests(agentDir).length;
  const off = toad(t, ['--json', '--no-replay'], { cwd: dir, agentDir });
  assert.equal(off.code, 0, off.err);
  assert.equal(off.report.suites[0].scenarios[0].mode, 'agent');
  assert.match(off.report.suites[0].scenarios[0].reason, /--no-replay/);
  assert.equal(off.report.suites[0].scenarios[0].proposed, undefined);
  assert.equal(requests(agentDir).length, before + 1);
  assert.ok(off.report.suites[0].runs.every(x => !x.replay));
});

test('stale, missing, malformed and symlinked recordings fall back to the agent; the valid one replays', t => {
  const agentDir = agent(t, {});
  const dir = project(t, { scenarios: [A, B, C, D, E], recordings: { [A.name]: READY, [B.name]: READY } });
  writeFileSync(join(dir, '.toad', 'suites', 'smoke.yaml'), suiteYaml([A, { ...B, expected: 'It prints 2.0.' }, C, D, E]));
  writeFileSync(savedFile(dir, D), '{');
  const outside = join(temp(t, 'toad-outside-'), 'e.json');
  writeFileSync(outside, JSON.stringify(envelope('cli', E, READY)));
  symlinkSync(outside, savedFile(dir, E));
  const r = toad(t, ['--json'], { cwd: dir, agentDir });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.report.suites[0].scenarios.map(s => [s.name, s.mode, s.result]), [
    [A.name, 'replay', 'PASS'], [B.name, 'agent', 'PASS'], [C.name, 'agent', 'PASS'], [D.name, 'agent', 'PASS'], [E.name, 'agent', 'PASS']]);
  assert.match(r.report.suites[0].scenarios[1].reason, /stale/);
  assert.match(r.report.suites[0].scenarios[3].reason, /not a valid recording/);
  assert.match(r.report.suites[0].scenarios[4].reason, /not a valid recording/, 'a symlink is never followed');
  const [request] = requests(agentDir);
  assert.equal(requests(agentDir).length, 1);
  assert.doesNotMatch(request.request, /"Prints ready"/, 'the replayed scenario is not sent to the agent');
  assert.match(request.request, /"Prints version"[\s\S]*"Counts items"/);
  assert.match(r.err, /warning: smoke › Prints version: the saved recording is stale/);
  assert.equal(r.report.warnings.length, 3);

  // Anything not replayable needs the agent, so its key is checked before anything runs.
  const noKey = toad(t, [], { cwd: dir, agentDir, extra: { DEEPSEEK_API_KEY: '' } });
  assert.equal(noKey.code, 3);
  assert.match(noKey.err, /no key for deepseek/);
});

test('partial suites replay only what is selected; write suites still need --allow-writes', t => {
  const agentDir = agent(t, {});
  const dir = project(t, { scenarios: [{ ...A, tags: ['fast'] }, C], recordings: { [A.name]: READY } });
  for (const args of [['--tag', 'fast'], ['--max-scenarios', '1'], ['--suite', 'smoke', '--max-scenarios', '1']]) {
    const r = toad(t, ['--json', ...args], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.deepEqual(r.report.suites[0].scenarios.map(s => [s.name, s.mode]), [[A.name, 'replay']]);
  }
  assert.deepEqual(requests(agentDir), []);

  const writer = project(t, { extra: 'writes: true\n' });
  const refused = toad(t, [], { cwd: writer, agentDir, extra: NO_MODEL(writer) });
  assert.equal(refused.code, 3);
  assert.match(refused.err, /declared `writes: true`/);
  assert.equal(existsSync(join(writer, '.toad', 'runs')), false, 'nothing ran');
  assert.equal(toad(t, ['--allow-writes'], { cwd: writer, agentDir, extra: NO_MODEL(writer) }).code, 0);
});

test('--workdir moves the replay; a replay that cannot run is an ERROR, never an agent call', t => {
  const agentDir = agent(t, { results: { [A.name]: ['FAIL'] } });
  const dir = project(t);
  const other = temp(t, 'toad-other-workdir-');
  writeCheck(other, 'other');
  const moved = toad(t, ['--json', '--retries', '0', '--workdir', other], { cwd: dir, agentDir });
  assert.equal(moved.code, 1, moved.err);
  assert.equal(moved.report.suites[0].scenarios[0].replay, 'FAIL', 'the override folder, not the suite\'s, was replayed');
  assert.match(requests(agentDir)[0].request, new RegExp(`working folder ${other}`));

  const before = requests(agentDir).length;
  const missing = toad(t, ['--json', '--workdir', join(other, 'missing')], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
  assert.equal(missing.code, 2, missing.err);
  const [s] = missing.report.suites[0].scenarios;
  assert.equal(s.result, 'ERROR');
  assert.equal(s.mode, 'replay');
  assert.deepEqual(s.attempts, ['ERROR', 'ERROR'], 'retried, as anything that did not pass');
  assert.match(s.message, /replay could not run/);
  assert.equal(requests(agentDir).length, before, 'no agent call');
});

test('API recordings replay against --url when they are under the suite URL, else the agent runs', async t => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }); res.end(req.url.startsWith('/v2') ? 'ok v2' : 'ok v1'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const agentDir = agent(t, {});
  const dir = temp(t, 'toad-replay-api-');
  mkdirSync(join(dir, '.toad', 'suites', 'api.recordings'), { recursive: true });
  writeFileSync(join(dir, '.toad', '.gitignore'), '.env\nruns/\n');
  writeFileSync(join(dir, '.toad', 'toad.yaml'), '');
  const H = { name: 'Health', steps: 'GET /health.', expected: 'It says ok.' };
  const O = { name: 'Elsewhere', steps: 'GET another host.', expected: 'It says ok.' };
  writeFileSync(join(dir, '.toad', 'suites', 'api.yaml'), `kind: api\ntarget: { url: '${base}/v1' }\ngoal: Check the API.\nscenarios:\n${[H, O].map(s => `  - name: ${s.name}\n    steps: ${s.steps}\n    expected: ${s.expected}`).join('\n')}\n`);
  const payload = url => ({ method: 'GET', url, headers: {}, body: '', expect: { status: 200, body: { contains: 'ok' } } });
  writeFileSync(savedFile(dir, H, 'api'), JSON.stringify(envelope('api', H, payload(`${base}/v1/health`))));
  // Outside the suite's /v1 base, so --url cannot say where it should go.
  writeFileSync(savedFile(dir, O, 'api'), JSON.stringify(envelope('api', O, payload(`${base}/elsewhere/health`))));

  const plain = await toadAsync(t, ['--json', '--suite', 'api', '--max-scenarios', '1'], { cwd: dir, agentDir, extra: NO_MODEL(dir) });
  assert.equal(plain.code, 0, plain.err);
  assert.deepEqual(plain.report.suites[0].scenarios.map(s => s.mode), ['replay']);
  assert.deepEqual(seen.splice(0), ['/v1/health']);

  const moved = await toadAsync(t, ['--json', '--url', `${base}/v2`], { cwd: dir, agentDir });
  assert.equal(moved.code, 0, moved.err);
  assert.deepEqual(moved.report.suites[0].scenarios.map(s => [s.name, s.mode]), [[H.name, 'replay'], [O.name, 'agent']]);
  assert.match(moved.report.suites[0].scenarios[1].reason, /not under the suite's current URL/);
  assert.deepEqual(seen, ['/v2/health'], 'the replay went to the override, never the suite URL');
  assert.equal(requests(agentDir).length, 1);

  // Editing the configured target must not silently replay against the old one.
  const suitePath = join(dir, '.toad', 'suites', 'api.yaml');
  writeFileSync(suitePath, readFileSync(suitePath, 'utf8').replace(`${base}/v1`, `${base}/v3`));
  seen.length = 0;
  const changed = await toadAsync(t, ['--json', '--max-scenarios', '1'], {cwd:dir, agentDir});
  assert.equal(changed.code, 0, changed.err);
  assert.equal(changed.report.suites[0].scenarios[0].mode, 'agent');
  assert.deepEqual(seen, [], 'the old API endpoint is never replayed after a target edit');
});

test('a missing replay program is an ERROR rather than a regression or agent fallback', t => {
  const agentDir = agent(t, {});
  const dir = project(t);
  rmSync(join(dir, 'check'));
  const r = toad(t, ['--json', '--retries', '0'], {cwd:dir, agentDir, extra:NO_MODEL(dir)});
  assert.equal(r.code, 2, r.err);
  assert.equal(r.report.suites[0].scenarios[0].result, 'ERROR');
  assert.equal(requests(agentDir).length, 0);
});

test('replay respects the suite deadline without invoking the agent', t => {
  const agentDir = agent(t, {});
  const dir = project(t);
  writeFileSync(join(dir, 'check'), '#!/bin/sh\nsleep 10\nprintf "ready\\n"\n', {mode:0o755});
  const started = Date.now();
  const r = toad(t, ['--json', '--retries', '0'], {cwd:dir, agentDir, extra:{...NO_MODEL(dir),TOAD_TEST_TIMEOUT_MS:'250'}});
  assert.equal(r.code, 2, r.err);
  assert.equal(r.report.suites[0].scenarios[0].result, 'ERROR');
  assert.ok(Date.now() - started < 8000, 'deadline cancels the workload');
  assert.equal(requests(agentDir).length, 0);
});

test('the run viewer shows modes and proposals in a fixed shape', async t => {
  const config = temp(t, 'toad-ui-config-');
  const previous = process.env.TOAD_CONFIG_DIR;
  process.env.TOAD_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.TOAD_CONFIG_DIR; else process.env.TOAD_CONFIG_DIR = previous; });
  const { registerProject, projectId } = await import('../projects.mjs');
  const { startUi } = await import('../ui.mjs');
  const dir = temp(t, 'toad-ui-replay-');
  const id = '2026-11-08T10-00-00-000Z-replay';
  const run = join(dir, '.toad', 'runs', id);
  mkdirSync(join(run, 'reports'), { recursive: true });
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({ version: 1, kind: 'cli', request: { goal: 'g', scenarios: [A] } }));
  writeFileSync(join(run, 'reports', 'report.md'), '# Toad run\n\nStatus: ok\n\nVerdict: PASS\n');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', verdict: 'PASS', scenarios: [{ name: A.name, result: 'PASS' }], replay: {
    suite: 'smoke', modes: { [A.name]: 'healed', other: 'bogus' }, accept: `toad suites accept ${id} --suite smoke`,
    proposed: { [A.name]: { steps: [{ action: 'x', assertion: 'y' }], previous: null, diff: ['+ x => y'], extra: 'dropped' } },
  } }));
  registerProject(dir);
  const { server, url } = await startUi({ port: 0 });
  t.after(() => server.close());
  const detail = await (await fetch(new URL(`/api/projects/${projectId(dir)}/runs/${id}`, url))).json();
  assert.deepEqual(detail.replay, { suite: 'smoke', modes: { [A.name]: 'healed' }, accept: `toad suites accept ${id} --suite smoke`,
    proposed: { [A.name]: { steps: [{ action: 'x', assertion: 'y' }], previous: null, diff: ['+ x => y'], updated: false } } });
  const state = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ ...state, replay: { ...state.replay, accept: 'rm -rf / ; toad suites accept x --suite y' } }));
  const tampered = await (await fetch(new URL(`/api/projects/${projectId(dir)}/runs/${id}`, url))).json();
  assert.equal(tampered.replay.accept, undefined, 'only an accept command of the fixed form is shown');
});
