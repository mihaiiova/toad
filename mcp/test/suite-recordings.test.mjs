import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { finalizeRecording, scenarioId } from '../recordings.mjs';
import { readProjectConfig, readSuites, projectId, registerProject } from '../projects.mjs';
import { parseSaveArgs, recordingWarnings, saveSuiteFromRun, suiteOverview } from '../suite-recordings.mjs';

const tmpdir = () => realpathSync(osTmpdir());
const CLI = resolve(import.meta.dirname, '../cli.mjs');
const config = mkdtempSync(join(tmpdir(), 'toad-suite-config-'));
process.env.TOAD_CONFIG_DIR = config;
process.on('exit', () => rmSync(config, { recursive: true, force: true }));

const READ_ONLY = 'This suite is declared read-only: do not create, change or delete data in the target.';
const A = { name: 'Prints ready', steps: 'Run ./check.', expected: 'It prints ready.' };
const B = { name: 'Fails loudly', steps: 'Run ./check --bad.', expected: 'It exits 2.' };
const PAYLOAD = { program: './check', args: [], expect: { exitCode: 0, stdout: { equals: 'ready\n' } } };
const STEPS = [{ action: './check', assertion: 'exit 0; stdout {"equals":"ready\\n"}' }];
const ID = '2026-11-08T10-00-00-000Z-abc';

/** A set-up project with one finished CLI run: A passed and was recorded, B failed. */
function fixture(t, { toadYaml = '', handoff = {}, record = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'toad-suite-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const run = join(project, '.toad', 'runs', ID);
  mkdirSync(join(run, 'receipts'), { recursive: true });
  mkdirSync(join(project, '.toad', 'suites'));
  writeFileSync(join(project, '.toad', '.gitignore'), '.env\nruns/\n');
  writeFileSync(join(project, '.toad', 'toad.yaml'), toadYaml);
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({
    version: 1, kind: 'cli', title: 'Checks', target: { workdir: project, program: './check' },
    request: { goal: 'Check the tool.', scenarios: [A, B] }, limitations: ['Use only temp files.', READ_ONLY], ...handoff,
  }));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ state: 'finished', status: 'ok', scenarios: [{ name: A.name, result: 'PASS' }, { name: B.name, result: 'FAIL' }] }));
  if (record) finalizeRecording(run, 'cli', A, 'cli-command-v1', PAYLOAD);
  return { project, run, suites: join(project, '.toad', 'suites') };
}

/** Every path and file content under a folder, to prove reads write nothing. */
function snapshot(dir) {
  const out = {};
  const visit = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out[p] = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : readFileSync(p, 'utf8') + statSync(p).mtimeMs; if (e.isDirectory()) visit(p); } };
  visit(dir);
  return out;
}

test('a run saves as a suite, with its valid recordings copied beside it', t => {
  const { project, run, suites } = fixture(t);
  const saved = saveSuiteFromRun(project, ID, 'smoke', { tags: ['smoke'] });
  assert.equal(saved.suite, join(suites, 'smoke.yaml'));
  assert.equal(saved.recordings, join(suites, 'smoke.recordings'));
  assert.deepEqual(saved.scenarios, [{ name: A.name, recording: 'recorded' }, { name: B.name, recording: 'none' }]);

  const [suite] = readSuites(join(project, '.toad'));
  assert.equal(suite.name, 'smoke');
  assert.deepEqual(suite.target, { workdir: '.', program: './check' }, 'the project folder is saved relative');
  assert.deepEqual(suite.scenarios, [A, B], 'steps and expected are preserved exactly');
  assert.deepEqual(suite.limitations, ['Use only temp files.'], 'the read-only limitation comes from writes, not the file');
  assert.equal(suite.writes, false);
  assert.deepEqual(suite.tags, ['smoke']);
  assert.equal(suite.title, 'Checks');
  const file = `${scenarioId(A.name)}.json`;
  assert.deepEqual(readdirSync(saved.recordings), [file]);
  assert.equal(readFileSync(join(saved.recordings, file), 'utf8'), readFileSync(join(run, 'recording', file), 'utf8'), 'the envelope is copied as it is');

  const overview = suiteOverview(project);
  assert.deepEqual(overview.warnings, []);
  assert.deepEqual(overview.suites[0].scenarios.map(s => s.recording), [{ status: 'recorded', steps: STEPS }, { status: 'none' }]);

  // Nothing is overwritten, and names cannot leave .toad/suites or reach outside .toad/runs.
  const before = snapshot(suites);
  assert.throws(() => saveSuiteFromRun(project, ID, 'smoke'), /smoke\.yaml already exists/);
  mkdirSync(join(suites, 'taken.recordings'));
  assert.throws(() => saveSuiteFromRun(project, ID, 'taken'), /taken\.recordings already exists/);
  rmSync(join(suites, 'taken.recordings'), { recursive: true });
  assert.throws(() => saveSuiteFromRun(project, ID, '../escape'), /suite name/);
  assert.throws(() => saveSuiteFromRun(project, '../../..', 'x'), /Not a run|No run/);
  assert.throws(() => saveSuiteFromRun(project, '/etc', 'x'), /Not a run/);
  assert.throws(() => saveSuiteFromRun(project, 'missing-run', 'x'), /No run/);
  assert.deepEqual(snapshot(suites), before, 'refused saves write nothing');

  // A run can also be named by its folder.
  assert.equal(saveSuiteFromRun(project, run, 'by-path').suite, join(suites, 'by-path.yaml'));
  assert.equal(saveSuiteFromRun(project, ID, 'writer', { writes: true }).scenarios.length, 2);
  assert.equal(readSuites(join(project, '.toad')).find(s => s.name === 'writer').writes, true);
});

test('saving refuses an unfinished run without creating a suite', t => {
  const { project, run, suites } = fixture(t);
  writeFileSync(join(run, 'state.json'), JSON.stringify({state:'running'}));
  assert.throws(() => saveSuiteFromRun(project, ID, 'unfinished'), /finished run/);
  assert.equal(existsSync(join(suites, 'unfinished.yaml')), false);
});

test('a run without recordings, or with credentials, saves no recording folder and no values', t => {
  const { project, suites } = fixture(t, { record: false, handoff: { credentials: { token: { env: 'API_TOKEN' } } } });
  const saved = saveSuiteFromRun(project, ID, 'plain');
  assert.equal(saved.recordings, null);
  assert.equal(existsSync(join(suites, 'plain.recordings')), false);
  assert.deepEqual(saved.scenarios.map(s => s.recording), ['none', 'none']);
  const text = readFileSync(saved.suite, 'utf8');
  assert.match(text, /env: API_TOKEN/, 'credentials stay references');
  assert.deepEqual(suiteOverview(project).suites[0].scenarios.map(s => s.recording.status), ['none', 'none']);
});

test('target fields toad.yaml already sets are left out of the saved suite', t => {
  const { project } = fixture(t, { toadYaml: 'cli:\n  program: ./check\n' });
  saveSuiteFromRun(project, ID, 'smoke');
  const [suite] = readSuites(join(project, '.toad'));
  assert.deepEqual(suite.target, { workdir: '.' });
});

test('stale, malformed and orphaned recordings are warnings, never errors, and reading writes nothing', t => {
  const { project, run, suites } = fixture(t);
  saveSuiteFromRun(project, ID, 'smoke');
  const yaml = join(suites, 'smoke.yaml'), original = readFileSync(yaml, 'utf8');
  const dir = join(suites, 'smoke.recordings'), file = join(dir, `${scenarioId(A.name)}.json`), envelope = readFileSync(file, 'utf8');
  const statuses = () => suiteOverview(project).suites[0].scenarios.map(s => s.recording.status === 'stale' ? `stale:${s.recording.reason}` : s.recording.status);

  // The scenario's intent changed after recording.
  writeFileSync(yaml, original.replace('It prints ready.', 'It prints done.'));
  assert.deepEqual(statuses(), ['stale:changed', 'none']);
  assert.match(suiteOverview(project).warnings.join('\n'), /smoke › Prints ready: the saved recording is stale/);
  assert.equal(readSuites(join(project, '.toad')).length, 1, 'the suite still reads');

  // The suite, or the project's defaults, now take it outside the codec.
  writeFileSync(yaml, original + 'credentials:\n  token: { env: API_TOKEN }\n');
  assert.deepEqual(statuses(), ['stale:unsupported', 'none']);
  writeFileSync(yaml, original);
  writeFileSync(join(project, '.toad', 'toad.yaml'), 'cli:\n  setup: [npm ci]\n');
  assert.deepEqual(statuses(), ['stale:unsupported', 'none']);
  writeFileSync(join(project, '.toad', 'toad.yaml'), '');
  assert.deepEqual(statuses(), ['recorded', 'none']);

  // Malformed, tampered and symlinked files are never recordings.
  writeFileSync(file, '{');
  assert.deepEqual(statuses(), ['stale:invalid', 'none']);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(envelope), payload: { ...PAYLOAD, program: '-c' } }));
  assert.deepEqual(statuses(), ['stale:unsupported', 'none']);
  unlinkSync(file);
  symlinkSync(join(run, 'recording', `${scenarioId(A.name)}.json`), file);
  assert.deepEqual(statuses(), ['stale:invalid', 'none']);
  unlinkSync(file);
  writeFileSync(file, envelope);

  // Files with no scenario, files that are not recordings, and folders with no suite.
  writeFileSync(join(dir, `${'0'.repeat(64)}.json`), envelope);
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  mkdirSync(join(suites, 'gone.recordings'));
  const { suites: list, warnings } = suiteOverview(project);
  assert.deepEqual(list[0].scenarios.map(s => s.recording.status), ['recorded', 'none']);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /0{64}\.json: no scenario of smoke has this id \(orphan\)/);
  assert.match(warnings.join('\n'), /notes\.txt: not a recording file/);
  assert.match(warnings.join('\n'), /gone\.recordings: no suite gone\.yaml uses it \(orphan\)/);
  assert.equal(recordingWarnings(project, readSuites(join(project, '.toad')), readProjectConfig(join(project, '.toad'))).length, 3);

  // A symlinked recordings folder is not followed.
  rmSync(dir, { recursive: true });
  symlinkSync(join(run, 'recording'), dir);
  assert.deepEqual(statuses(), ['none', 'none']);
  assert.match(suiteOverview(project).warnings.join('\n'), /smoke\.recordings is not a plain folder/);

  // Warnings never contain recorded values.
  assert.doesNotMatch(suiteOverview(project).warnings.join('\n'), /ready\\n|\.\/check/);

  const before = snapshot(join(project, '.toad'));
  suiteOverview(project);
  recordingWarnings(project, readSuites(join(project, '.toad')), {});
  assert.deepEqual(snapshot(join(project, '.toad')), before, 'checking recordings writes nothing');
});

test('an invalid suite file is reported to the viewer, not thrown', t => {
  const { project, suites } = fixture(t);
  writeFileSync(join(suites, 'bad.yaml'), 'kind: nope\n');
  const overview = suiteOverview(project);
  assert.deepEqual(overview.suites, []);
  assert.match(overview.error, /bad\.yaml/);
});

test('save arguments parse and validate', () => {
  assert.deepEqual(parseSaveArgs([ID, '--name', 'smoke', '--tag', 'a', '--tag=b', '--writes']), { tags: ['a', 'b'], writes: true, name: 'smoke', run: ID });
  for (const bad of [[], [ID], ['--name', 'x'], [ID, 'other', '--name', 'x'], [ID, '--name'], [ID, '--name', 'x', '--nope'], [ID, '--writes=1', '--name', 'x']]) {
    assert.throws(() => parseSaveArgs(bad), undefined, bad.join(' '));
  }
});

test('toad suites save saves from the command line and the viewer lists suites read-only', async t => {
  const { project, suites } = fixture(t);
  const ok = spawnSync(process.execPath, [CLI, 'suites', 'save', ID, '--name', 'smoke'], { cwd: project, encoding: 'utf8', env: process.env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Saved \.toad\/suites\/smoke\.yaml: 2 scenarios, 1 with a recording/);
  assert.match(ok.stdout, /toad run --suite smoke/);
  const again = spawnSync(process.execPath, [CLI, 'suites', 'save', ID, '--name', 'smoke', '--project', project], { encoding: 'utf8', env: process.env });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  const usage = spawnSync(process.execPath, [CLI, 'suites', 'save', ID], { cwd: project, encoding: 'utf8', env: process.env });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /--name is required/);

  registerProject(project);
  const { startUi } = await import('../ui.mjs');
  const { server, url } = await startUi({ port: 0 });
  t.after(() => server.close());
  const before = snapshot(suites);
  const res = await fetch(new URL(`/api/projects/${projectId(project)}/suites`, url));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.suites.map(s => [s.name, s.kind]), [['smoke', 'cli']]);
  assert.deepEqual(body.suites[0].scenarios.map(s => [s.name, s.recording.status]), [[A.name, 'recorded'], [B.name, 'none']]);
  assert.deepEqual(body.suites[0].scenarios[0].recording.steps, STEPS);
  assert.deepEqual(snapshot(suites), before, 'the viewer writes nothing');
  assert.equal((await fetch(new URL('/api/projects/000000000000/suites', url))).status, 404);
  assert.equal((await fetch(new URL(`/api/projects/${projectId(project)}/suites`, url), { method: 'POST' })).status, 405);
});
