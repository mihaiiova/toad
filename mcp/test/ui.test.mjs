import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
// Project paths must be canonical; on macOS the temp folder is behind a symlink.
const tmpdir = () => realpathSync(osTmpdir());
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgetProject, listProjects, projectId, registerProject } from '../projects.mjs';
import { startUi } from '../ui.mjs';

const cli = resolve(import.meta.dirname, '../cli.mjs');
// The project list is read from TOAD_CONFIG_DIR on every call.
const config = mkdtempSync(join(tmpdir(), 'toad-ui-config-'));
process.env.TOAD_CONFIG_DIR = config;

function project(t, name, runs) {
  const path = mkdtempSync(join(tmpdir(), `toad-ui-${name}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const [id, verdict, goal] of runs) {
    const run = join(path, '.toad', 'runs', id);
    mkdirSync(join(run, 'receipts', 'scenario'), { recursive: true });
    mkdirSync(join(run, 'reports'));
    writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({ version: 1, kind: 'web', target: { url: 'http://localhost:3000' }, request: { goal } }));
    writeFileSync(join(run, 'reports', 'report.md'), `# Toad run\n\nStatus: ok\n\nVerdict: ${verdict}\n`);
    writeFileSync(join(run, 'receipts', 'scenario', '01-home.txt'), 'evidence');
  }
  registerProject(path);
  return path;
}

test('one viewer lists and serves the runs of every registered project', async t => {
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const a = project(t, 'a', [['2026-11-01T10-00-00-000Z-a1', 'PASS', 'Sign in']]);
  const b = project(t, 'b', [['2026-11-02T10-00-00-000Z-b1', 'FAIL', 'Checkout']]);
  const gone = join(tmpdir(), 'toad-ui-never-created');
  registerProject(gone);
  assert.equal(registerProject(a), false, 'listing is idempotent');
  assert.equal(readFileSync(join(config, 'projects.json'), 'utf8').match(/"path"/g).length, 3);

  const { server, url } = await startUi({ port: 0 });
  t.after(() => server.close());
  const get = async path => { const res = await fetch(new URL(path, url)); return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() }; };

  const projects = (await get('/api/projects')).body;
  assert.deepEqual(projects.map(p => p.path).sort(), [a, b].sort(), 'projects without runs are skipped');
  const all = (await get('/api/runs')).body;
  assert.deepEqual(all.map(r => [r.goal, r.verdict]), [['Checkout', 'FAIL'], ['Sign in', 'PASS']], 'newest first, across projects');
  const onlyA = (await get(`/api/runs?project=${projectId(a)}`)).body;
  assert.deepEqual(onlyA.map(r => r.goal), ['Sign in']);

  const detail = (await get(`/api/projects/${projectId(a)}/runs/2026-11-01T10-00-00-000Z-a1`)).body;
  assert.equal(detail.projectPath, a);
  assert.deepEqual(detail.files.map(f => f.path), ['receipts/scenario/01-home.txt']);
  assert.equal(detail.state, 'finished');
  assert.equal(detail.verdict, 'PASS');
  const file = await get(`/api/projects/${projectId(a)}/runs/2026-11-01T10-00-00-000Z-a1/file/${encodeURIComponent('receipts/scenario/01-home.txt')}`);
  assert.equal(file.body, 'evidence');

  // A run id from one project cannot be read through another, or by traversal.
  assert.equal((await get(`/api/projects/${projectId(b)}/runs/2026-11-01T10-00-00-000Z-a1`)).status, 404);
  assert.equal((await get(`/api/projects/${projectId(a)}/runs/2026-11-01T10-00-00-000Z-a1/file/${encodeURIComponent('../../../.env')}`)).status, 400);
  symlinkSync('/etc/hostname', join(a, '.toad', 'runs', '2026-11-01T10-00-00-000Z-a1', 'receipts', 'link.txt'));
  assert.equal((await get(`/api/projects/${projectId(a)}/runs/2026-11-01T10-00-00-000Z-a1/file/${encodeURIComponent('receipts/link.txt')}`)).status, 404);
  assert.equal((await get('/api/projects/000000000000/runs/x')).status, 404);

  assert.equal(forgetProject(gone), true);
  assert.equal(listProjects().length, 2);
  const listed = spawnSync(process.execPath, [cli, 'projects'], { encoding: 'utf8', env: process.env });
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [a, b].sort());
});

test('without an explicit port the viewer moves to the next free one', async t => {
  const first = await startUi();
  t.after(() => first.server.close());
  const second = await startUi();
  t.after(() => second.server.close());
  assert.notEqual(first.url, second.url);
  await assert.rejects(startUi({ port: first.server.address().port }), /already in use/);
});

test('runs report whether they are running, finished or interrupted', async t => {
  const path = project(t, 'state', [['2026-11-03T09-00-00-000Z-done', 'FAIL', 'Finished run']]);
  const runs = join(path, '.toad', 'runs');
  const make = (id, state) => {
    mkdirSync(join(runs, id, 'receipts'), { recursive: true });
    writeFileSync(join(runs, id, 'handoff.yaml'), JSON.stringify({ version: 1, kind: 'cli', target: { program: 'node x.js' }, request: { goal: id } }));
    writeFileSync(join(runs, id, 'state.json'), JSON.stringify(state));
  };
  make('2026-11-03T10-00-00-000Z-live', { state: 'running', pid: process.pid, started: '2026-11-03T10:00:00.000Z' });
  make('2026-11-03T11-30-00-000Z-failed', { state: 'failed', pid: process.pid, error: 'The Toad agent is not set up on this machine.', started: '2026-11-03T11:30:00.000Z' });
  // A run that never recorded a state, as an older server left them.
  mkdirSync(join(runs, '2026-11-03T11-40-00-000Z-orphan', 'receipts'), { recursive: true });
  writeFileSync(join(runs, '2026-11-03T11-40-00-000Z-orphan', 'handoff.yaml'), JSON.stringify({ version: 1, kind: 'cli', title: 'Orphan', request: { goal: 'Check the orphan. It has two sentences.' } }));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  make('2026-11-03T11-00-00-000Z-dead', { state: 'running', pid: Number(dead), started: '2026-11-03T11:00:00.000Z' });
  const { server, url } = await startUi({ port: 0 });
  t.after(() => server.close());
  const get = async p => (await fetch(new URL(p, url))).json();
  const id = projectId(path);
  const list = await get(`/api/projects/${id}/runs`);
  assert.deepEqual(list.map(r => [r.goal, r.state, r.verdict]), [
    ['Check the orphan. It has two sentences.', 'interrupted', 'INTERRUPTED'],
    ['2026-11-03T11-30-00-000Z-failed', 'failed', 'ERROR'],
    ['2026-11-03T11-00-00-000Z-dead', 'interrupted', 'INTERRUPTED'],
    ['2026-11-03T10-00-00-000Z-live', 'running', 'RUNNING'],
    ['Finished run', 'finished', 'FAIL'],
  ]);
  const summary = (await get('/api/projects')).find(p => p.id === id);
  assert.equal(summary.active, 1);
  assert.equal(summary.finished, 1);
  assert.equal(summary.recent.length, 5);
  assert.equal(list[0].title, 'Orphan');
  assert.equal(list[1].error, 'The Toad agent is not set up on this machine.');
  const detail = await get(`/api/projects/${id}/runs/2026-11-03T10-00-00-000Z-live`);
  assert.equal(detail.older, '2026-11-03T09-00-00-000Z-done');
  assert.equal(detail.newer, '2026-11-03T11-00-00-000Z-dead');
  const page = await fetch(url);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(await page.text(), /__VERSION__/);
});

test('a run is titled by its handoff title or its goal\'s first sentence', async () => {
  const { titleOf } = await import('../ui.mjs');
  assert.equal(titleOf({ title: 'Smoke', request: { goal: 'Long goal.' } }), 'Smoke');
  assert.equal(titleOf({ request: { goal: 'Investigate import safety. Use only disposable files.' } }), 'Investigate import safety.');
  assert.ok(titleOf({ request: { goal: 'word '.repeat(40) } }).length <= 90);
});

test('a finished run carries each scenario\'s result from its report', async t => {
  const path = mkdtempSync(join(tmpdir(), 'toad-ui-results-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = join(path, '.toad', 'runs', '2026-11-03T12-00-00-000Z-r');
  mkdirSync(join(run, 'reports'), { recursive: true });
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify({ version: 1, kind: 'cli', request: { goal: 'g', scenarios: [{ name: 'A', steps: 's', expected: 'e' }, { name: 'B', steps: 's', expected: 'e' }] } }));
  writeFileSync(join(run, 'reports', 'report.md'), '# Toad run\n\nStatus: ok\n\nVerdict: FAIL\nResults:\n- PASS | A\n- FAIL | B\n');
  registerProject(path);
  const { server, url } = await startUi({ port: 0 });
  t.after(() => server.close());
  const [r] = await (await fetch(new URL(`/api/projects/${projectId(path)}/runs`, url))).json();
  assert.deepEqual(r.results, [{ name: 'A', result: 'PASS' }, { name: 'B', result: 'FAIL' }]);
});
