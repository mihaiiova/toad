import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exitCodeOf, finalResult, junit, outcomes, parseRunArgs, selectScenarios, slug, suiteRunHandoff, summary } from '../toad-run.mjs';
import { readSuites, suiteHandoff } from '../projects.mjs';
import { sessionCost } from '../run.mjs';

const tmpdir = () => realpathSync(osTmpdir());
const CLI = resolve(import.meta.dirname, '../cli.mjs');
// The pinned pi-commands package: an agent that has it counts as set up.
const COMMANDS = '.pi/git/github.com/mihaiiova/pi-commands/package.json';

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in agent: a fake `pi` (TOAD_PI) whose test skill answers each
 * requested scenario from behaviour.json: { results: { name: [first,
 * second, …] }, cost, delay }, as Pi's JSON mode would. It records every
 * request, and writes a Pi session with the given cost.
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
fs.appendFileSync('requests', JSON.stringify({ request, pre, sandbox: process.env.TOAD_CLI_SANDBOX ?? null, secrets: process.env.TOAD_CLI_SECRETS_FILE ? JSON.parse(fs.readFileSync(process.env.TOAD_CLI_SECRETS_FILE, 'utf8')) : null }) + '\\n');
const sessions = pre[pre.indexOf('--session-dir') + 1];
if (b.cost && sessions) fs.writeFileSync(path.join(sessions, 'lead.jsonl'), JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { cost: { total: b.cost } } } }) + '\\n');
const counts = fs.existsSync('counts.json') ? JSON.parse(fs.readFileSync('counts.json', 'utf8')) : {};
const names = [...request.matchAll(/^\\d+\\. "(.+?)":/gm)].map(m => m[1]);
const lines = names.map(name => { const i = counts[name] = (counts[name] ?? -1) + 1; const list = b.results?.[name] ?? ['PASS']; return '- ' + list[Math.min(i, list.length - 1)] + ' | ' + name; });
fs.writeFileSync('counts.json', JSON.stringify(counts));
const verdict = lines.some(l => l.includes('FAIL')) ? 'FAIL' : lines.some(l => l.includes('ERROR')) ? 'ERROR' : 'PASS';
const done = () => {
  if (b.status === 'error') { console.error('pi failed'); process.exit(1); }
  console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: ['Verdict: ' + verdict, 'Results:', ...lines].join('\\n') }] }] }));
  process.exit(0);
};
process.on('SIGTERM', () => process.exit(143));
setTimeout(done, b.delay ?? 0);
`, { mode: 0o755 });
  return dir;
}

function project(t, suites, config = '') {
  const dir = temp(t, 'toad-project-');
  mkdirSync(join(dir, '.toad', 'suites'), { recursive: true });
  writeFileSync(join(dir, '.toad', '.gitignore'), '.env\nruns/\n');
  writeFileSync(join(dir, '.toad', 'toad.yaml'), config);
  for (const [name, text] of Object.entries(suites)) writeFileSync(join(dir, '.toad', 'suites', `${name}.yaml`), text);
  return dir;
}

function toad(t, args, { cwd, agentDir, env = {} }) {
  const home = temp(t, 'toad-home-');
  const result = spawnSync(process.execPath, [CLI, 'run', ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, TOAD_AGENT_DIR: agentDir, TOAD_PI: join(agentDir, 'fake-pi.mjs'), TOAD_CONFIG_DIR: join(home, 'config'), TOAD_CACHE_DIR: join(home, 'cache'), TOAD_RUNTIME_DIR: join(home, 'runtime'), DEEPSEEK_API_KEY: 'test-key', ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const CLI_SUITE = (names, extra = '') => `kind: cli
target: { workdir: ., program: tool }
goal: Check the tool.
${extra}scenarios:
${names.map(n => `  - { name: ${n}, steps: Run it., expected: It works. }`).join('\n')}
`;

test('run options parse, repeat and validate', () => {
  const o = parseRunArgs(['--suite', 'a', '--suite=b', '--tag', 'smoke', '--env', 'A,B', '--env=C', '--max-scenarios', '3', '--json', '--model', 'x/y', '--max-cost=0.5']);
  assert.deepEqual(o.suites, ['a', 'b']);
  assert.deepEqual(o.env, ['A', 'B', 'C']);
  assert.equal(o.maxScenarios, 3);
  assert.equal(o.retries, 1);
  assert.equal(o.maxCost, 0.5);
  assert.deepEqual(o.models, { lead: 'x/y', tester: 'x/y' });
  assert.equal(o.json, true);
  for (const bad of [['--nope'], ['--suite'], ['--retries', '-1'], ['--sandbox', 'host'], ['--env', '1X'], ['--url', 'nope'], ['--lead-model', 'plain'], ['--json=1'], ['stray']]) {
    assert.throws(() => parseRunArgs(bad), undefined, bad.join(' '));
  }
});

test('scenarios are chosen by suite and tag and capped in order', () => {
  const suites = [
    { name: 'api', tags: ['smoke'], scenarios: [{ name: 'a1' }, { name: 'a2' }] },
    { name: 'web', scenarios: [{ name: 'w1', tags: ['smoke'] }, { name: 'w2' }] },
  ];
  const names = plan => plan.flatMap(p => p.scenarios.map(s => s.name));
  assert.deepEqual(names(selectScenarios(suites)), ['a1', 'a2', 'w1', 'w2']);
  assert.deepEqual(names(selectScenarios(suites, { tags: ['smoke'] })), ['a1', 'a2', 'w1']);
  assert.deepEqual(names(selectScenarios(suites, { max: 3 })), ['a1', 'a2', 'w1']);
  assert.deepEqual(names(selectScenarios(suites, { names: ['web', 'api'], max: 3 })), ['w1', 'w2', 'a1']);
  assert.throws(() => selectScenarios(suites, { names: ['nope'] }), /No suite named nope/);
});

test('results combine into flaky, final results and exit codes', () => {
  assert.equal(finalResult(['FAIL', 'PASS']), 'FLAKY');
  assert.equal(finalResult(['PASS']), 'PASS');
  assert.equal(finalResult(['FAIL', 'FAIL']), 'FAIL');
  assert.equal(exitCodeOf(['PASS', 'FLAKY']), 0);
  assert.equal(exitCodeOf(['PASS', 'ERROR', 'FAIL']), 1);
  assert.equal(exitCodeOf(['PASS', 'ERROR']), 2);
  const s = [{ name: 'A' }, { name: 'B' }];
  assert.deepEqual(outcomes(s, { status: 'ok', verdict: 'FAIL', scenarios: [{ name: 'a', result: 'PASS' }] }), ['PASS', 'ERROR']);
  assert.deepEqual(outcomes(s, { status: 'ok', verdict: 'PASS', scenarios: [] }), ['PASS', 'PASS'], 'a passing run without a results block');
  assert.deepEqual(outcomes(s, { status: 'timeout', verdict: 'UNKNOWN', scenarios: [] }), ['ERROR', 'ERROR']);
  assert.deepEqual(outcomes(s, { status: 'error', verdict: 'FAIL', scenarios: [{ name: 'A', result: 'PASS' }, { name: 'B', result: 'FAIL' }] }), ['ERROR', 'FAIL'], 'an incomplete run proves failures, not passes');
  assert.equal(slug('Rejects a missing token!'), 'rejects-a-missing-token');
});

test('suites are validated with the file named, and become handoffs', t => {
  const dir = project(t, { good: CLI_SUITE(['one', 'two'], 'tags: [smoke]\nwrites: true\n'), example: '# only comments\n' });
  const [suite] = readSuites(join(dir, '.toad'));
  assert.equal(suite.name, 'good');
  const handoff = suiteHandoff(suite);
  assert.equal(handoff.title, 'good');
  assert.deepEqual(handoff.request.scenarios.map(s => Object.keys(s)), [['name', 'steps', 'expected'], ['name', 'steps', 'expected']], 'tags stay with the suite');
  assert.equal(handoff.limitations, undefined, 'a write suite gets no read-only limitation');
  const ro = suiteHandoff({ ...suite, writes: false });
  assert.match(ro.limitations.join(' '), /read-only/);
  const overridden = suiteRunHandoff({ ...suite, kind: 'api' }, suite.scenarios, { url: 'https://preview.example/api', workdir: '/tmp' });
  assert.equal(overridden.target.url, 'https://preview.example/api');
  assert.equal(overridden.target.workdir, '/tmp');
  writeFileSync(join(dir, '.toad', 'suites', 'bad.yaml'), CLI_SUITE(['same', 'Same']));
  assert.throws(() => readSuites(join(dir, '.toad')), /bad\.yaml: scenarios\.1\.name: scenario names must be distinct/);
  writeFileSync(join(dir, '.toad', 'suites', 'bad.yaml'), 'kind: cli\ngoal: g\nscenarios: []\n');
  assert.throws(() => readSuites(join(dir, '.toad')), /bad\.yaml: scenarios/);
});

test('JUnit escapes names and marks failures, errors and flaky passes', () => {
  const report = { seconds: 12, verdict: 'FAIL', notes: [], suites: [{ name: 'smoke', seconds: 12, runs: [{ folder: '.toad/runs/x' }], scenarios: [
    { name: 'A <&> "b"', result: 'FAIL', attempts: ['FAIL', 'FAIL'], receipts: '.toad/runs/x/receipts/a' },
    { name: 'C', result: 'FLAKY', attempts: ['FAIL', 'PASS'] },
    { name: 'D', result: 'ERROR', attempts: ['ERROR'], message: 'Run timeout' },
  ] }] };
  const xml = junit(report);
  assert.match(xml, /tests="3" failures="1" errors="1"/);
  assert.match(xml, /name="A &lt;&amp;&gt; &quot;b&quot;"/);
  assert.match(xml, /<failure [^>]*>Result: FAIL \(attempts: FAIL, FAIL\)/);
  assert.match(xml, /<property name="flaky" value="true"\/>/);
  assert.match(xml, /<error message="Run timeout"/);
  const md = summary(report);
  assert.match(md, /^## Toad: FAIL/);
  assert.match(md, /0 passed, 1 failed, 1 flaky, 1 errored/);
  assert.match(md, /Flaky \(failed, then passed on a retry\): C\./);
});

test('session cost sums assistant replies and skips the subagent copies', t => {
  const dir = temp(t, 'toad-sessions-');
  const reply = cost => JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { cost } } });
  writeFileSync(join(dir, 'lead.jsonl'), [reply({ total: 0.25 }), reply(0.5), JSON.stringify({ type: 'message', message: { role: 'user' } })].join('\n'));
  mkdirSync(join(dir, 'lead', 'x', 'run-0'), { recursive: true });
  writeFileSync(join(dir, 'lead', 'x', 'run-0', 'session.jsonl'), reply({ total: 1 }));
  mkdirSync(join(dir, 'subagent-artifacts'));
  writeFileSync(join(dir, 'subagent-artifacts', 'x_transcript.jsonl'), reply({ total: 100 }));
  assert.equal(sessionCost(dir), 1.75);
});

test('toad run exits 0 when every scenario passes and writes JUnit, a summary and JSON', async t => {
  const agentDir = agent(t, { cost: 0.01 });
  const dir = project(t, { smoke: CLI_SUITE(['Shows help', 'Prints version']) });
  const r = toad(t, ['--json', '--junit', 'out/junit.xml', '--summary', 'out/summary.md'], { cwd: dir, agentDir });
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(report.suites[0].scenarios.map(s => s.result), ['PASS', 'PASS']);
  assert.equal(report.cost, 0.01);
  assert.match(readFileSync(join(dir, 'out', 'junit.xml'), 'utf8'), /<testcase classname="toad.smoke" name="Shows help">/);
  assert.match(readFileSync(join(dir, 'out', 'summary.md'), 'utf8'), /## Toad: PASS/);
  const runs = readdirSync(join(dir, '.toad', 'runs'));
  assert.equal(runs.length, 1, 'one run, shown in toad ui like any other');
  const state = JSON.parse(readFileSync(join(dir, '.toad', 'runs', runs[0], 'state.json'), 'utf8'));
  assert.equal(state.origin, 'cli');
  assert.equal(state.verdict, 'PASS');
  const [request] = readFileSync(join(agentDir, 'requests'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(request.request, /do not create, change or delete data/, 'suites are read-only unless they declare writes');
  assert.ok(request.pre.includes('--session-dir'), 'Pi keeps the sessions with the run');
});

test('toad run retries what failed, reports flaky passes, and exits 1 on a real failure', t => {
  const agentDir = agent(t, { results: { Flaky: ['FAIL', 'PASS'], Broken: ['FAIL', 'FAIL'] } });
  const dir = project(t, { smoke: CLI_SUITE(['Fine', 'Flaky', 'Broken']) });
  const r = toad(t, ['--json'], { cwd: dir, agentDir });
  assert.equal(r.code, 1, r.err);
  const scenarios = JSON.parse(r.out).suites[0].scenarios;
  assert.deepEqual(scenarios.map(s => [s.name, s.result, s.attempts.join(',')]), [['Fine', 'PASS', 'PASS'], ['Flaky', 'FLAKY', 'FAIL,PASS'], ['Broken', 'FAIL', 'FAIL,FAIL']]);
  const requests = readFileSync(join(agentDir, 'requests'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[1].request, /"Fine"/, 'the retry runs only what did not pass');
  assert.equal(toad(t, ['--retries', '0', '--suite', 'smoke', '--max-scenarios', '2'], { cwd: dir, agentDir }).code, 0, 'without retries Flaky now passes (its counter moved on)');
});

test('toad run exits 2 when a run errors, and stops at the spending limit', t => {
  const agentDir = agent(t, { status: 'error' });
  const dir = project(t, { smoke: CLI_SUITE(['One']) });
  const r = toad(t, ['--json', '--retries', '0'], { cwd: dir, agentDir });
  assert.equal(r.code, 2, r.err);
  assert.equal(JSON.parse(r.out).suites[0].scenarios[0].result, 'ERROR');

  const costly = agent(t, { cost: 5, delay: 8000 });
  const c = toad(t, ['--json', '--max-cost', '1'], { cwd: dir, agentDir: costly });
  assert.equal(c.code, 2, c.err);
  const report = JSON.parse(c.out);
  assert.equal(report.suites[0].runs[0].status, 'cost_limit');
  assert.equal(report.suites[0].runs.length, 1, 'no retry after the limit');
  assert.match(report.notes.join(' '), /spending limit/);
});

test('toad run exits 3 for missing keys, write suites, bad suites and missing credentials', t => {
  const agentDir = agent(t, {});
  const dir = project(t, { smoke: CLI_SUITE(['One']), writer: CLI_SUITE(['Two'], 'writes: true\n') });
  const noKey = toad(t, ['--suite', 'smoke'], { cwd: dir, agentDir, env: { DEEPSEEK_API_KEY: '' } });
  assert.equal(noKey.code, 3);
  assert.match(noKey.err, /no key for deepseek.*Set DEEPSEEK_API_KEY/);
  const writes = toad(t, [], { cwd: dir, agentDir });
  assert.equal(writes.code, 3);
  assert.match(writes.err, /writer is declared `writes: true`.*--allow-writes/);
  assert.equal(existsSync(join(agentDir, 'requests')), false, 'nothing ran');
  assert.equal(toad(t, ['--allow-writes'], { cwd: dir, agentDir }).code, 0);
  assert.equal(toad(t, ['--suite', 'nope'], { cwd: dir, agentDir }).code, 3);

  writeFileSync(join(dir, '.toad', 'suites', 'secret.yaml'), CLI_SUITE(['Three'], 'credentials: { token: { env: CI_TOKEN } }\n'));
  const missing = toad(t, ['--suite', 'secret'], { cwd: dir, agentDir });
  assert.equal(missing.code, 3, missing.err);
  const fromEnv = toad(t, ['--suite', 'secret', '--env', 'CI_TOKEN', '--sandbox', 'none'], { cwd: dir, agentDir, env: { CI_TOKEN: 'ci-secret-value' } });
  assert.equal(fromEnv.code, 0, fromEnv.err);
  const last = readFileSync(join(agentDir, 'requests'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual(last.secrets, { CI_TOKEN: 'ci-secret-value' }, 'the value reaches the sandbox from the CI environment');
  assert.equal(last.sandbox, 'none');
  assert.match(last.request, /no sandbox on this machine/);
  assert.doesNotMatch(last.request, /ci-secret-value/, 'never in the request');

  writeFileSync(join(dir, '.toad', 'suites', 'broken.yaml'), 'kind: cli\n');
  const broken = toad(t, [], { cwd: dir, agentDir });
  assert.equal(broken.code, 3);
  assert.match(broken.err, /broken\.yaml/);
});

test('models from flags or toad.yaml run on a copy of the agent, never the shared one', { skip: !existsSync(resolve(import.meta.dirname, '../../agent', COMMANDS)) && 'the checkout agent is not set up (cd agent && ./run)' }, async t => {
  const { agentFor, agentModels, resolveAgent, resolveModels } = await import('../agent.mjs');
  const data = temp(t, 'toad-data-');
  process.env.TOAD_DATA_DIR = data;
  t.after(() => { delete process.env.TOAD_DATA_DIR; });
  const shared = resolveAgent({});
  const before = agentModels(shared);
  const models = resolveModels(shared, { flags: { tester: 'anthropic/claude-haiku-4-5' }, project: { lead: 'anthropic/claude-sonnet-4-5', tester: 'openai/gpt-5' } });
  assert.deepEqual(models, { lead: 'anthropic/claude-sonnet-4-5', tester: 'anthropic/claude-haiku-4-5' }, 'flags, then toad.yaml');
  assert.equal(resolveModels(shared).lead, before.lead.model, 'then what the agent runs on');
  const variant = agentFor(shared, models);
  assert.ok(variant.startsWith(join(data, 'agent-variants')));
  assert.equal(agentModels(variant).lead.model, 'anthropic/claude-sonnet-4-5');
  assert.ok(agentModels(variant).testers.every(x => x.model === 'anthropic/claude-haiku-4-5'));
  assert.equal(agentFor(shared, models), variant, 'reused');
  assert.equal(agentFor(shared, resolveModels(shared)), shared, 'the agent itself when nothing changes');
  assert.deepEqual(agentModels(shared), before, 'the shared agent is untouched');
});
