import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readProjectConfig, readSuites } from '../projects.mjs';
import { describeRecording, finalizeRecording, intentHash, readRecordingFile, recordingHash, recordingText, scenarioId } from '../recordings.mjs';
import { inspectSuite, saveSuiteFromRun } from '../suite-recordings.mjs';
import { acceptRecordings, proposedRecording, replayChoices, replayScenario, stepsDiff, writeSuiteRecording } from '../replay.mjs';
import { handoffSchema, runProject } from '../run.mjs';

const S = { name: 'Checks fixture', steps: 'Run the supported fixture.', expected: 'It returns the expected literal.' };
const CLI = resolve(import.meta.dirname, '../cli.mjs');
const DRIVER = resolve(import.meta.dirname, 'fake-web-driver.mjs');
const SECRET = 'SENTINEL_DO_NOT_ECHO_26';
const cliPayload = value => ({ program: './check', args: [], expect: { exitCode: 0, stdout: { equals: `${value}\n` } } });
const apiPayload = (url, value) => ({ method: 'GET', url: `${url}/health`, headers: {}, body: '', expect: { status: 200, body: { equals: value } } });
const webPayload = value => ({ steps: [{ action: 'goto', url: 'http://app.test/page' }, { action: 'expectText', target: { role: 'status', name: 'Result' }, contains: value }] });

function temp(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'toad-authoring-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(project, id, handoff, payload) {
  const dir = join(project, '.toad', 'runs', id);
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  writeFileSync(join(dir, 'handoff.yaml'), JSON.stringify(handoff));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', verdict: 'PASS', scenarios: [{ name: S.name, result: 'PASS' }] }));
  finalizeRecording(dir, handoff.kind, S, { cli: 'cli-command-v1', api: 'api-request-v1', web: 'web-scenario-v1' }[handoff.kind], payload);
  return dir;
}
function fixture(t, kind = 'cli', url = 'http://app.test') {
  const project = temp(t);
  mkdirSync(join(project, '.toad', 'suites'), { recursive: true });
  writeFileSync(join(project, '.toad', 'toad.yaml'), '# absent defaults are deliberate\n');
  writeFileSync(join(project, '.toad', '.gitignore'), '.env\nruns/\n');
  const target = kind === 'cli' ? { workdir: project, program: './check' } : { url, ...(kind === 'api' ? { workdir: project } : {}) };
  const handoff = { version: 1, kind, target, request: { goal: 'Check fixture.', scenarios: [S] } };
  const payload = kind === 'cli' ? cliPayload('old') : kind === 'api' ? apiPayload(url, 'old') : webPayload('old');
  const originalRun = run(project, 'original', handoff, payload);
  saveSuiteFromRun(project, originalRun, 'smoke');
  const suiteFile = join(project, '.toad', 'suites', 'smoke.yaml');
  const file = join(project, '.toad', 'suites', 'smoke.recordings', `${scenarioId(S.name)}.json`);
  const read = () => ({ suite: readSuites(join(project, '.toad'))[0], config: readProjectConfig(join(project, '.toad')) });
  return { project, handoff, payload, originalRun, suiteFile, file, read };
}
function safeError(fn, pattern) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, 'definition must be refused');
  assert.doesNotMatch(error.message, new RegExp(SECRET));
  assert.match(error.message, pattern);
  assert.ok(error.diagnostics?.length);
  assert.ok(error.diagnostics.every(d => d.path && d.remedy && !JSON.stringify(d).includes(SECRET)));
  return error;
}

test('readProjectConfig and readSuites report safe exact source locations, paths and remedies', t => {
  const project = temp(t), folder = join(project, '.toad');
  mkdirSync(join(folder, 'suites'), { recursive: true });
  const configFile = join(folder, 'toad.yaml');
  assert.deepEqual(readProjectConfig(folder), {});
  writeFileSync(configFile, '# just comments\n');
  assert.deepEqual(readProjectConfig(folder), {});
  writeFileSync(join(folder, 'suites', 'example.yaml'), '# just comments\n');
  assert.deepEqual(readSuites(folder), []);
  writeFileSync(configFile, `cli:\n  path:\n    - tools/bin\n    - ../${SECRET}\n`);
  let error = safeError(() => readProjectConfig(folder), /toad\.yaml:4:7: cli\.path\.1/);
  assert.deepEqual({ line: error.diagnostics[0].line, column: error.diagnostics[0].column }, { line: 4, column: 7 });
  writeFileSync(configFile, `models: { tester: ${SECRET} }\n`);
  safeError(() => readProjectConfig(folder), /models\.tester/);
  writeFileSync(configFile, `${SECRET}: hidden\n`);
  safeError(() => readProjectConfig(folder), /Unsupported field/);
  writeFileSync(configFile, `web: [${SECRET}\n`);
  safeError(() => readProjectConfig(folder), /Malformed definition syntax/);
  unlinkSync(configFile);
  symlinkSync(join(project, 'missing-config'), configFile);
  safeError(() => readProjectConfig(folder), /regular definition file without symlinks/);
  unlinkSync(configFile);
  writeFileSync(configFile, '# defaults remain optional\n');

  const suiteFile = join(folder, 'suites', 'bad.yaml');
  const suffix = 'scenarios:\n  - name: One\n    steps: Run.\n    expected: Ready.\n';
  writeFileSync(suiteFile, `kind: cli\ngoal: Check.\ntarget:\n  workdir: .\n  program: ./check\n  path:\n    - tools/bin\n    - ../${SECRET}\n${suffix}`);
  safeError(() => readSuites(folder), /bad\.yaml:8:7: target\.path\.1/);
  writeFileSync(suiteFile, `kind: cli\ngoal: Check.\ncredentials:\n  ${SECRET}: { value: ${SECRET} }\n${suffix}`);
  safeError(() => readSuites(folder), /credentials\.\[entry\]/);
  writeFileSync(suiteFile, `kind: cli\ngoal: Check.\n${suffix}  - name: ONE\n    steps: Run.\n    expected: Ready.\n`);
  error = safeError(() => readSuites(folder), /scenarios\.1\.name: Scenario names must be distinct/);
  assert.equal(error.diagnostics[0].line, 7);
  writeFileSync(suiteFile, `kind: [${SECRET}\n`);
  safeError(() => readSuites(folder), /Malformed definition syntax/);
});

test('handoffSchema and project execution refuse invalid literal fields safely before launch', async t => {
  const f = fixture(t);
  const bad = { ...f.handoff, target: { ...f.handoff.target, path: [`../${SECRET}`] } };
  assert.equal(handoffSchema.safeParse(bad).success, false);
  await assert.rejects(runProject({ project_path: f.project, handoff: bad }, {}, { env: { TOAD_AGENT_DIR: '/must-not-launch' } }), error => {
    assert.match(error.message, /handoff: target\.path\.0/);
    assert.doesNotMatch(error.message, new RegExp(SECRET));
    return true;
  });
});

for (const kind of ['cli', 'api', 'web']) test(`save -> inspect -> literal edit -> validate -> replay: ${kind}, without a model`, async t => {
  let url = 'http://app.test';
  if (kind === 'api') {
    const server = createServer((req, res) => { res.writeHead(200); res.end('new'); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => server.close());
    url = `http://127.0.0.1:${server.address().port}`;
  }
  const f = fixture(t, kind, url);
  const original = readFileSync(f.file, 'utf8');
  assert.match(original, /\n  "payload": \{/);
  assert.equal(original, readFileSync(join(f.originalRun, 'recording', `${scenarioId(S.name)}.json`), 'utf8'));
  const { suite, config } = f.read();
  const before = inspectSuite(f.project, suite, config).recordings[0];
  const value = JSON.parse(original);
  if (kind === 'cli') { value.payload.expect.stdout = { equals: 'new\n' }; writeFileSync(join(f.project, 'check'), '#!/bin/sh\nprintf "new\\n"\n', { mode: 0o755 }); }
  if (kind === 'api') value.payload.expect.body = { equals: 'new' };
  if (kind === 'web') value.payload.steps[1].contains = 'new';
  writeFileSync(f.file, JSON.stringify(value, null, 2) + '\n');
  const inspection = inspectSuite(f.project, suite, config);
  assert.deepEqual(inspection.errors, []);
  assert.equal(inspection.recordings[0].status, 'recorded', 'valid literal edits keep intent binding');
  assert.ok(stepsDiff(before.steps, inspection.recordings[0].steps).some(line => line.startsWith('+ ') && line.includes('new')));
  assert.deepEqual(describeRecording(readRecordingFile(f.file), kind, S, { handoff: f.handoff, scenario: S }), inspection.recordings[0].steps);
  const [choice] = replayChoices(f.project, suite, config, suite.scenarios);
  assert.equal(choice.mode, 'replay');
  const receipts = join(f.project, 'replayed');
  mkdirSync(receipts);
  const env = { ...process.env, TOAD_CLI_SANDBOX: 'none', TOAD_RUNTIME_DIR: join(f.project, 'runtime'), TOAD_RECEIPTS_DIR: receipts };
  if (kind === 'web') {
    const app = join(f.project, 'app.json');
    writeFileSync(app, JSON.stringify({ pages: { '/page': { elements: [{ role: 'status', name: 'Result', text: 'new' }] } } }));
    Object.assign(env, { TOAD_WEB_DRIVER: JSON.stringify([process.execPath, DRIVER]), FAKE_WEB_APP: app, FAKE_WEB_LOG: join(f.project, 'calls.log') });
  }
  const result = await replayScenario(choice.envelope, { workdir: f.project, receipts, env, targetUrl: url });
  assert.equal(result.result, 'PASS', result.message);
  assert.equal(value.intentHash, intentHash(kind, S));
  const stale = { ...suite, scenarios: [{ ...S, expected: 'New intent requires re-recording.' }] };
  assert.equal(replayChoices(f.project, stale, config, stale.scenarios)[0].mode, 'agent');
});

test('invalid recording edits have safe locations and never become executable, even with stale intent', t => {
  const f = fixture(t, 'web');
  const { suite, config } = f.read();
  const good = JSON.parse(readFileSync(f.file, 'utf8'));
  const cases = [
    { ...good, codec: SECRET },
    { ...good, version: 99 },
    { ...good, payload: { steps: [good.payload.steps[0], { action: SECRET, value: SECRET }] } },
    { ...good, payload: { steps: [good.payload.steps[0], { action: 'fill', target: { label: 'Password' }, value: SECRET }, good.payload.steps[1]] } },
    { ...good, payload: { steps: [{ action: 'goto', url: `http://user:${SECRET}@app.test/page` }, good.payload.steps[1]] } },
    { ...good, payload: { steps: [{ action: 'goto', url: 'http://elsewhere.test/page' }, good.payload.steps[1]] } },
  ];
  for (const bad of cases) {
    writeFileSync(f.file, JSON.stringify(bad, null, 2) + '\n');
    const inspection = inspectSuite(f.project, suite, config);
    assert.ok(inspection.errors.length);
    assert.ok(inspection.errors[0].line > 0 && inspection.errors[0].column > 0);
    if (bad.payload?.steps?.[1]?.target?.label === 'Password') assert.equal(inspection.errors[0].path, 'payload.steps.1.target.label');
    safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /recordings\/.*\.json:\d+:\d+:/);
    safeError(() => replayChoices(f.project, { ...suite, scenarios: [{ ...S, expected: 'Changed intent' }] }, config, [{ ...S, expected: 'Changed intent' }]), /recordings/);
  }
  writeFileSync(f.file, `{\n "payload": "${SECRET}",\n`);
  safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /Malformed definition syntax/);
  writeFileSync(f.file, JSON.stringify({ ...good, payload: { steps: Array(10000).fill(good.payload.steps[0]) } }));
  safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /bounded regular file/);
  unlinkSync(f.file);
  symlinkSync(join(f.originalRun, 'recording', `${scenarioId(S.name)}.json`), f.file);
  safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /without symlinks/);
});

for (const kind of ['cli', 'api']) test(`reader/inspect/replay preflight refuses unsupported ${kind} edits without echoing valid or invalid secrets`, t => {
  const f = fixture(t, kind);
  const { suite, config } = f.read();
  const good = JSON.parse(readFileSync(f.file, 'utf8'));
  const badPayloads = kind === 'cli' ? [
    { ...good.payload, program: '-c', args: [SECRET] },
    { ...good.payload, args: [null, SECRET] },
    { ...good.payload, expect: { exitCode: 999, stdout: { equals: SECRET } } },
  ] : [
    { ...good.payload, headers: { authorization: SECRET } },
    { ...good.payload, url: 'http://elsewhere.test/health' },
    { ...good.payload, url: `http://user:${SECRET}@app.test/health` },
    { ...good.payload, expect: { status: 999, body: { equals: SECRET } } },
  ];
  for (const payload of badPayloads) {
    writeFileSync(f.file, JSON.stringify({ ...good, payload }, null, 2));
    const error = safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /Unsupported or unsafe recording data/);
    assert.match(error.diagnostics[0].path, /^payload\./);
    assert.ok(error.diagnostics[0].line > 1 && error.diagnostics[0].column > 0);
    const restricted = { ...suite, credentials: { token: { env: 'TOKEN' } } };
    safeError(() => replayChoices(f.project, restricted, config, restricted.scenarios), /Unsupported or unsafe recording data/);
  }
});

test('generated formatting/hash is stable across object insertion order, not array order', t => {
  const f = fixture(t);
  const value = JSON.parse(readFileSync(f.file, 'utf8'));
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.payload = { expect: { stdout: { equals: 'old\n' }, exitCode: 0 }, args: [], program: './check' };
  assert.equal(recordingText(value), recordingText(reordered));
  assert.equal(recordingHash(value), recordingHash(reordered));
  assert.notEqual(recordingText({ args: ['a', 'b'] }), recordingText({ args: ['b', 'a'] }));
});

test('saved original-target context distinguishes legitimate target staleness from unsafe edits and legacy ambiguity', t => {
  for (const kind of ['web', 'api']) {
    const f = fixture(t, kind);
    const { suite, config } = f.read();
    const moved = { ...suite, target: { ...suite.target, url: 'http://preview.test' } };
    assert.match(replayChoices(f.project, moved, config, moved.scenarios)[0].reason, /suite target changed/);
    const context = join(f.project, '.toad', 'suites', 'smoke.recording-context.json');
    const baseline = readFileSync(context, 'utf8');
    unlinkSync(context);
    safeError(() => replayChoices(f.project, moved, config, moved.scenarios), /no matching original-target provenance/);
    assert.equal(replayChoices(f.project, suite, config, suite.scenarios)[0].mode, 'replay', 'legacy files under current target need no migration');
    writeFileSync(context, baseline);
    const edited = JSON.parse(readFileSync(f.file, 'utf8'));
    if (kind === 'api') edited.payload.url = 'http://preview.test/health';
    else edited.payload.steps[0].url = 'http://preview.test/page';
    writeFileSync(f.file, JSON.stringify(edited, null, 2));
    assert.equal(replayChoices(f.project, moved, config, moved.scenarios)[0].mode, 'replay', 'valid current-target edits do not require matching old sidecar');
    safeError(() => replayChoices(f.project, suite, config, suite.scenarios), /no matching original-target provenance/);
    writeFileSync(context, JSON.stringify({ version: 1, entries: { [scenarioId(S.name)]: { envelopeHash: recordingHash(edited), originalTarget: `http://user:${SECRET}@preview.test` } } }));
    safeError(() => replayChoices(f.project, moved, config, moved.scenarios), /originalTarget/);
  }
});

test('static config/suite/recording errors precede model and browser launch, including --no-replay', t => {
  const f = fixture(t, 'web');
  const marker = join(f.project, 'launched');
  const pi = join(f.project, 'fake-pi');
  writeFileSync(pi, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const goodSuite = readFileSync(f.suiteFile, 'utf8');
  const goodRecording = readFileSync(f.file, 'utf8');
  const configFile = join(f.project, '.toad', 'toad.yaml');
  const scenarios = [
    () => writeFileSync(configFile, `models: { lead: ${SECRET} }\n`),
    () => { writeFileSync(configFile, ''); writeFileSync(f.suiteFile, `kind: [${SECRET}\n`); },
    () => { writeFileSync(f.suiteFile, goodSuite); writeFileSync(f.file, goodRecording.replace('web-scenario-v1', SECRET)); },
  ];
  for (const edit of scenarios) {
    edit();
    const result = spawnSync(process.execPath, [CLI, 'run', '--no-replay', '--sandbox', 'none', '--project', f.project], { encoding: 'utf8', env: { ...process.env, TOAD_PI: pi, TOAD_AGENT_DIR: f.project, TOAD_WEB_DRIVER: JSON.stringify([process.execPath, DRIVER]), FAKE_WEB_LOG: marker } });
    assert.equal(result.status, 3, result.stderr);
    assert.doesNotMatch(result.stderr, new RegExp(SECRET));
    assert.doesNotMatch(result.stderr, /no key|Preparing the testing agent|Installing the browser/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readFileSync(join(f.originalRun, 'state.json'), 'utf8').includes('PASS'), true);
  }
});

function proposalFixture(t, kind = 'cli') {
  const f = fixture(t, kind);
  const { suite, config } = f.read();
  const [choice] = replayChoices(f.project, suite, config, suite.scenarios);
  const payload = kind === 'cli' ? cliPayload('new') : apiPayload(f.handoff.target.url, 'new');
  const investigation = run(f.project, 'investigation', f.handoff, payload);
  const proposal = proposedRecording(investigation, f.project, suite, config, S, { envelope: choice.saved, steps: choice.savedSteps }, { snapshot: choice.snapshot });
  assert.ok(proposal);
  const stateFile = join(investigation, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, replay: { suite: suite.name, proposed: { [S.name]: proposal } } }));
  return { ...f, suite, config, investigation, proposal, stateFile };
}

test('proposal acceptance binds old/new payload and intent/context, keeps history immutable, and refuses old provenance', t => {
  const f = proposalFixture(t);
  const history = readFileSync(f.stateFile, 'utf8');
  assert.deepEqual(f.proposal.diff, ['- ./check => exit 0; stdout {"equals":"old\\n"}', '+ ./check => exit 0; stdout {"equals":"new\\n"}']);
  assert.equal(f.proposal.provenance.savedHash, recordingHash(JSON.parse(readFileSync(f.file, 'utf8'))));
  assert.equal(acceptRecordings(f.project, f.investigation, 'smoke')[0].status, 'accepted');
  assert.equal(readFileSync(f.stateFile, 'utf8'), history);
  assert.equal(acceptRecordings(f.project, f.investigation, 'smoke')[0].status, 'unchanged');
  assert.match(readFileSync(f.file, 'utf8'), /\n  "payload":/);

  for (const change of ['saved', 'intent', 'context', 'proposed', 'legacy']) {
    const f = proposalFixture(t);
    const before = readFileSync(f.file, 'utf8');
    if (change === 'saved') { const e = JSON.parse(before); e.payload.expect.stdout = { contains: 'old' }; writeFileSync(f.file, JSON.stringify(e)); }
    if (change === 'intent') writeFileSync(f.suiteFile, readFileSync(f.suiteFile, 'utf8').replace(S.expected, 'Changed expectation.'));
    if (change === 'context') writeFileSync(join(f.project, '.toad', 'toad.yaml'), 'cli:\n  image: changed-image\n');
    if (change === 'proposed') { const path = join(f.investigation, 'recording', `${scenarioId(S.name)}.json`); const e = JSON.parse(readFileSync(path, 'utf8')); e.payload.expect.stdout = { contains: 'new' }; writeFileSync(path, JSON.stringify(e)); }
    if (change === 'legacy') { const state = JSON.parse(readFileSync(f.stateFile, 'utf8')); delete state.replay.proposed[S.name].provenance; writeFileSync(f.stateFile, JSON.stringify(state)); }
    const current = readFileSync(f.file, 'utf8');
    assert.throws(() => acceptRecordings(f.project, f.investigation, 'smoke'), /regenerate|Regenerate|provenance/i, change);
    assert.equal(readFileSync(f.file, 'utf8'), current, 'refusal never overwrites the current file');
  }
});

test('proposal absent-file snapshots, cooperative concurrency, path confinement and sidecar publication fail closed', t => {
  const f = proposalFixture(t);
  const absent = fixture(t);
  unlinkSync(absent.file);
  const { suite, config } = absent.read();
  const choice = replayChoices(absent.project, suite, config, suite.scenarios)[0];
  assert.equal(choice.snapshot.savedHash, null);
  const investigation = run(absent.project, 'investigation', absent.handoff, cliPayload('new'));
  const p = proposedRecording(investigation, absent.project, suite, config, S, null, { snapshot: choice.snapshot });
  writeFileSync(absent.file, JSON.stringify(p.envelope));
  assert.throws(() => writeSuiteRecording(absent.project, 'smoke', p.envelope, { provenance: p.provenance }), /provenance/);
  assert.throws(() => writeSuiteRecording(f.project, '../escape', f.proposal.envelope, { provenance: f.proposal.provenance }), /suite name/);
  const lock = join(f.project, '.toad', 'suites', '.smoke.recording-lock');
  mkdirSync(lock);
  assert.throws(() => acceptRecordings(f.project, f.investigation, 'smoke'), /already active or interrupted/);
  rmSync(lock, { recursive: true });
  const api = proposalFixture(t, 'api');
  const context = join(api.project, '.toad', 'suites', 'smoke.recording-context.json');
  unlinkSync(context);
  symlinkSync(join(api.originalRun, 'state.json'), context);
  const before = readFileSync(api.file, 'utf8');
  assert.throws(() => writeSuiteRecording(api.project, 'smoke', api.proposal.envelope, { provenance: api.proposal.provenance }));
  assert.equal(readFileSync(api.file, 'utf8'), before, 'failed context publication never publishes the new envelope');
});

test('stepsDiff preserves ordering, duplicate actions and removed/changed assertions', () => {
  const a = { action: 'open A', assertion: 'text equals A' }, b = { action: 'open B', assertion: 'visible' };
  assert.notDeepEqual(stepsDiff([a, b], [b, a]), []);
  assert.deepEqual(stepsDiff([a, a], [a]), ['- open A => text equals A']);
  assert.deepEqual(stepsDiff([a], [{ ...a, assertion: 'text contains A' }]), ['- open A => text equals A', '+ open A => text contains A']);
});
