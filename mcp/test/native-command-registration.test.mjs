import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { parse } from 'yaml';
import { readExecutionRecords } from '../../agent/tools/toad-execution.mjs';

const agent = resolve(import.meta.dirname, '../../agent');
const installed = join(agent, '.pi/git/github.com/mihaiiova/pi-commands');
const available = existsSync(join(installed, 'index.mjs'));
const settings = JSON.parse(readFileSync(join(agent, '.pi/settings.json')));
const native = available ? await import(pathToFileURL(join(installed, 'index.mjs'))) : null;
const commands = available ? await import(pathToFileURL(join(installed, 'commands.mjs'))) : null;
const skip = !available && 'pinned pi-commands not installed; no automatic setup';

// Exercise the installed extension's actual session_start and registration, not a
// fake Pi executable or a reimplementation of its placeholder validation.
function registered(child = true) {
  const events = {}, tools = [];
  native.default({ on: (name, fn) => { events[name] = fn; }, registerTool: tool => tools.push(tool) }, { env: { PI_SUBAGENT_CHILD: child ? '1' : '0' } });
  events.session_start({}, { cwd: agent, hasUI: false });
  return tools;
}

test('shipped command declarations register every CLI/API tester tool through pinned pi-commands', { skip }, () => {
  assert.ok(settings.packages.includes('git:github.com/mihaiiova/pi-commands@v0.1.0'));
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, '0.1.0');
  assert.deepEqual(commands.loadConfig(agent).problems, [], 'invalid config suppresses ALL command tools');
  const tools = registered();
  for (const name of ['cli-tester', 'api-tester']) {
    const doc = readFileSync(join(agent, `.pi/agents/${name}.md`), 'utf8');
    const declaration = parse(doc.split('---')[1]);
    for (const tool of declaration.tools) assert.ok(tools.some(t => t.name === tool), `${name} requires ${tool}`);
    assert.ok(doc.includes('--scenario-name {scenario_name}'));
  }
  assert.equal(registered(false).length, 0, 'lead permissions remain unchanged');
  const source = parse(readFileSync(join(agent, '.pi/system.yaml'), 'utf8'));
  // Source/native argument alignment without regenerating unrelated Faur output.
  const findCommands = value => {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(findCommands);
    return [...(value.name && Array.isArray(value.args) ? [value] : []), ...Object.values(value).flatMap(findCommands)];
  };
  const declared = findCommands(source);
  for (const entry of commands.loadConfig(agent).commands) {
    assert.deepEqual(declared.find(c => c.name === entry.name)?.args, entry.args, entry.name);
  }
  for (const name of ['run-command', 'run-command-with-input']) {
    const entry = commands.loadConfig(agent).commands.find(c => c.name === name);
    const tool = tools.find(t => t.name === commands.toolName(name));
    assert.ok(tool.parameters.properties.scenario_name);
    const values = Object.fromEntries(commands.placeholders(entry.args).map(p => [p.name, 'Exact scenario / 1']));
    const argv = commands.buildArgv(entry.args, values, null);
    assert.equal(argv[argv.indexOf('--scenario-name') + 1], 'Exact scenario / 1');
    assert.throws(() => commands.buildArgv(entry.args, { ...values, scenario_name: '-option' }, null));
  }
});

test('no-model native Pi session exposes the pinned command tools under tester allowlists', { skip, timeout: 15000 }, async t => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-native-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi')); writeFileSync(join(root, '.pi/commands.json'), readFileSync(join(agent, '.pi/commands.json')));
  const settingsManager = SettingsManager.inMemory({ packages: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'home'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => native.default(pi, { env: { PI_SUBAGENT_CHILD: '1' } })] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  for (const name of ['cli-tester', 'api-tester']) {
    const allowed = parse(readFileSync(join(agent, `.pi/agents/${name}.md`), 'utf8').split('---')[1]).tools;
    const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'home'), settingsManager, resourceLoader, modelRuntime, tools: allowed, sessionManager: SessionManager.inMemory(root) });
    try {
      await session.bindExtensions({});
      assert.deepEqual(session.getActiveToolNames().sort(), allowed.slice().sort(), 'post-session_start native active tools must match tester requirements');
    } finally { session.dispose(); }
    // Each child session loads its own extension closure (registered is session-local).
    await resourceLoader.reload();
  }
});

const bwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore', timeout: 3000 }).status === 0;
test('registered native CLI/API tools produce real bwrap receipts and attributed assertions', { skip: skip || (!bwrap && 'Bubblewrap unavailable; no sandbox downgrade'), timeout: 30000 }, async t => {
  const tools = registered();
  assert.ok(tools.length, 'required command tools absent: no execution receipt can be produced');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-native-commands-'));
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); });
  // The registered extension spawns with process.env: explicitly exclude host
  // provider credentials, inherited selectors and recording/attempt switches.
  for (const key of Object.keys(process.env)) if (!['PATH', 'HOME', 'LANG', 'TMPDIR'].includes(key)) delete process.env[key];
  const run = join(root, 'run'), receipts = join(run, 'receipts'), project = join(root, 'project');
  mkdirSync(receipts, { recursive: true }); mkdirSync(project);
  const empty = join(root, 'empty.json'); writeFileSync(empty, '{}', { mode: 0o600 });
  Object.assign(process.env, { TOAD_CLI_SANDBOX: 'bwrap', TOAD_RECEIPTS_DIR: receipts, TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_CLI_SECRETS_FILE: empty, TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_SCENARIOS: '["Exact scenario / 1"]', TOAD_EXECUTION_KIND: 'cli' });
  const call = (name, args) => tools.find(t => t.name === name).execute('offline', args, undefined, undefined, { cwd: agent, hasUI: false });
  const prep = await call('cli_prepare_scenario', { workdir: project });
  assert.notEqual(prep.isError, true, 'real sandbox preparation must succeed');
  const scenario = /Scenario ID: (.+)/.exec(prep.content[0].text)?.[1]; assert.ok(scenario);
  const base = { scenario, receipts, scenario_name: 'Exact scenario / 1' };
  assert.notEqual((await call('cli_run_command', { ...base, name: '01-normal', command: 'printf ready' })).isError, true);
  assert.notEqual((await call('cli_run_command_with_input', { ...base, name: '02-input', command: 'cat', input: 'input-proof' })).isError, true);
  assert.match(readFileSync(join(receipts, '02-input.txt'), 'utf8'), /input-proof/);
  const request = { scenario, receipts, scenarioName: base.scenario_name, name: '03-structured', program: 'printf', args: ['ready'], expect: { exitCode: 0, stdout: { equals: 'ready' } }, capture: { scenarioName: base.scenario_name, complete: true } };
  process.env.TOAD_RECORDING_ENABLED = 'cli-v1';
  assert.notEqual((await call('cli_run_structured_command', { request: JSON.stringify(request) })).isError, true);
  assert.ok(existsSync(join(receipts, '03-structured.txt.recording.json')), 'real successful receipt backs capture');
  // Existing evidence cannot be overwritten, even when the assertion fails.
  const proof = readFileSync(join(receipts, '03-structured.txt'));
  const fail = await call('cli_run_structured_command', { request: JSON.stringify({ ...request, expect: { exitCode: 0, stdout: { equals: 'wrong' } } }) });
  assert.equal(fail.isError, true); assert.match(fail.content[0].text, /"status":"fail"/);
  assert.deepEqual(readFileSync(join(receipts, '03-structured.txt')), proof);
  const records = readExecutionRecords(run).records;
  assert.ok(records.every(r => r.scenarioName === base.scenario_name));
  assert.equal(records.filter(r => r.outcome === 'completed').length, 2);
  assert.ok(records.some(r => r.outcome === 'PASS' && r.verification.source === 'machine' && r.evidenceComplete));
  assert.ok(records.some(r => r.outcome === 'FAIL' && !r.evidenceComplete), 'FAIL precedence survives receipt error');

  const server = createServer((req, res) => { res.writeHead(200); res.end('{"total":6}'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  process.env.TOAD_EXECUTION_KIND = 'api'; process.env.TOAD_RECORDING_ENABLED = 'api-v1';
  const api = { scenario, receipts, scenarioName: base.scenario_name, name: '04-api', capture: request.capture, payload: { method: 'GET', url: `http://127.0.0.1:${server.address().port}/invoice`, headers: {}, body: '', expect: { status: 200, body: { contains: '"total":6' } } } };
  assert.notEqual((await call('cli_run_structured_api', { request: JSON.stringify(api) })).isError, true);
  assert.ok(existsSync(join(receipts, '04-api.txt.recording.json')));
  const wrongApi = { ...api, name: '05-api-fail', payload: { ...api.payload, expect: { status: 200, body: { contains: '"total":5' } } } };
  assert.equal((await call('cli_run_structured_api', { request: JSON.stringify(wrongApi) })).isError, true);
  assert.equal(existsSync(join(receipts, '05-api-fail.txt.recording.json')), false);
  const apiRecords = readExecutionRecords(run).records.filter(r => r.kind === 'api');
  assert.deepEqual(apiRecords.map(r => r.outcome), ['PASS', 'FAIL']);
  assert.ok(apiRecords.every(r => r.evidenceComplete && r.scenarioName === base.scenario_name && r.verification.source === 'machine'));
  assert.deepEqual(apiRecords[0].steps.map(s => s.assertion.kind), ['httpStatus', 'body']);
});
