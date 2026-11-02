import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    writeFileSync(join(run, 'reports', 'report.md'), `# TOaD run\n\nStatus: ok\n\nVerdict: ${verdict}\n`);
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
  assert.deepEqual(detail.files, ['receipts/scenario/01-home.txt']);
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
