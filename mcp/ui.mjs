/**
 * TOaD run viewer: one localhost web interface over the runs of every project
 * TOaD has been set up in (the list in ~/.config/toad/projects.json).
 *
 *   toad ui                # http://127.0.0.1:8787, or the next free port
 *   toad ui --port 9000    # exactly this port
 *
 * It binds to localhost only; run artifacts can contain sensitive data.
 */
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { listProjects } from './projects.mjs';

const HOST = '127.0.0.1';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8',
};

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function projects() { return listProjects().filter(p => p.present); }

function requireProject(id) {
  const project = projects().find(p => p.id === id);
  if (!project) throw httpError(404, 'Project not found');
  return project;
}

function runDirs(project) {
  if (!existsSync(project.runs)) return [];
  return readdirSync(project.runs, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse(); // run ids start with a fixed-width timestamp, so newest first
}

function requireRun(project, id) {
  const decoded = decodeURIComponent(id);
  if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) throw httpError(404, 'Run not found');
  const dir = join(project.runs, decoded);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw httpError(404, 'Run not found');
  return dir;
}

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function readText(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

function metaOf(report) {
  return {
    verdict: /^Verdict:\s*(\S+)/m.exec(report)?.[1]?.toUpperCase() ?? 'UNKNOWN',
    status: /^Status:\s*(\S+)/m.exec(report)?.[1] ?? 'unknown',
  };
}

function timeOf(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : id;
}

function targetOf(handoff) {
  if (!handoff) return '';
  if (handoff.kind === 'web') return handoff.target?.url ?? '';
  if (handoff.kind === 'cli') return (handoff.target?.workdir ?? '') + (handoff.target?.program ? ` — ${handoff.target.program}` : '');
  return '';
}

function listRuns(only) {
  return projects().filter(p => !only || p.id === only).flatMap(project => runDirs(project).map(id => {
    const dir = join(project.runs, id);
    const handoff = readJson(join(dir, 'handoff.yaml'));
    const meta = metaOf(readText(join(dir, 'reports', 'report.md')));
    return {
      id, time: timeOf(id), kind: handoff?.kind ?? '', goal: handoff?.request?.goal ?? '',
      target: targetOf(handoff), verdict: meta.verdict, status: meta.status,
      project: project.id, projectName: project.name,
    };
  })).sort((a, b) => b.id.localeCompare(a.id));
}

function detail(project, id) {
  const dir = requireRun(project, id);
  const handoff = readJson(join(dir, 'handoff.yaml')) ?? {};
  const report = readText(join(dir, 'reports', 'report.md'));
  const meta = metaOf(report);
  return { id, project: project.id, projectName: project.name, projectPath: project.path, time: timeOf(id), verdict: meta.verdict, status: meta.status, handoff, report, files: receiptFiles(dir) };
}

function receiptFiles(dir) {
  const files = [];
  const receipts = join(dir, 'receipts');
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path.slice(dir.length + 1));
    }
  }
  try { if (existsSync(receipts)) visit(receipts); } catch { /* unreadable receipts are omitted */ }
  return files;
}

function serveFile(res, project, id, rel) {
  const dir = requireRun(project, id);
  const decoded = decodeURIComponent(rel);
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').includes('..')) throw httpError(400, 'Invalid path');
  const target = join(dir, decoded);
  let st;
  try { st = lstatSync(target); } catch { throw httpError(404, 'File not found'); }
  if (!st.isFile()) throw httpError(404, 'Not a file');
  const data = readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length, 'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendJson(res, body, status = 200) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname;
    if (path === '/') return sendHtml(res, HTML);
    if (path === '/api/projects') return sendJson(res, projects().map(({ id, name, path }) => ({ id, name, path })));
    if (path === '/api/runs') return sendJson(res, listRuns(url.searchParams.get('project')));
    let m;
    if ((m = /^\/api\/projects\/([0-9a-f]{12})\/runs\/([^/]+)$/.exec(path))) return sendJson(res, detail(requireProject(m[1]), m[2]));
    if ((m = /^\/api\/projects\/([0-9a-f]{12})\/runs\/([^/]+)\/file\/(.+)$/.exec(path))) return serveFile(res, requireProject(m[1]), m[2], m[3]);
    return sendJson(res, { error: 'Not found' }, 404);
  } catch (error) {
    if (!res.headersSent) sendJson(res, { error: error.message ?? 'Internal error' }, error.status ?? 500);
  }
}

/**
 * Serve the viewer. Without an explicit port it starts at 8787 and moves up
 * to the next free one, so several viewers can run at once.
 */
export function startUi({ port, host = HOST } = {}) {
  const explicit = port !== undefined;
  let candidate = explicit ? port : 8787;
  return new Promise((done, fail) => {
    const server = createServer(handler);
    server.on('error', error => {
      if (error.code === 'EADDRINUSE' && !explicit && candidate < 8787 + 20) { candidate += 1; server.listen(candidate, host); return; }
      fail(error.code === 'EADDRINUSE' ? new Error(`Port ${candidate} is already in use. Choose another with --port <port>.`) : error);
    });
    server.listen(candidate, host, () => done({ server, url: `http://${host}:${server.address().port}/` }));
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TOaD runs</title>
<style>
:root { --bg:#0f1115; --panel:#171a21; --border:#262b36; --text:#e6e8ee; --muted:#8b93a7; --accent:#58a6ff; --pass:#2ea043; --fail:#f85149; --error:#d29922; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); }
header h1 { font-size:16px; margin:0; font-weight:600; }
header .path { color:var(--muted); font-size:12px; }
header select { margin-left:auto; background:#21262f; color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:inherit; max-width:40vw; }
button { background:#21262f; color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
button:hover { background:#2b313d; }
main { display:grid; grid-template-columns:320px 1fr; height:calc(100vh - 49px); }
#runs { border-right:1px solid var(--border); overflow-y:auto; }
.run { padding:12px 14px; border-bottom:1px solid var(--border); cursor:pointer; }
.run:hover { background:#1a1f29; }
.run.active { background:#1f2430; box-shadow:inset 3px 0 0 var(--accent); }
.run .time { color:var(--muted); font-size:12px; }
.run .goal { margin:4px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.badge { display:inline-block; font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; margin-right:6px; }
.badge.pass { background:rgba(46,160,67,.15); color:var(--pass); }
.badge.fail { background:rgba(248,81,73,.15); color:var(--fail); }
.badge.error { background:rgba(210,153,34,.15); color:var(--error); }
.badge.unknown { background:rgba(110,118,129,.2); color:var(--muted); }
.kind, .proj { color:var(--muted); font-size:12px; }
.proj { margin-left:6px; }
#detail { overflow-y:auto; padding:20px 24px; }
.empty { color:var(--muted); padding:40px; text-align:center; }
h2 { font-size:18px; margin:0 0 8px; }
h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:24px 0 8px; }
.meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
.meta .time { color:var(--muted); font-size:12px; }
.field { margin:6px 0; }
.field .label, .status { color:var(--muted); font-size:12px; }
pre { background:#10131a; border:1px solid var(--border); border-radius:8px; padding:14px; overflow:auto; font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap; word-break:break-word; }
.scenario { border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:8px 0; }
.scenario .name { font-weight:600; margin-bottom:4px; }
.scenario .steps, .scenario .expected { color:var(--muted); font-size:13px; margin:2px 0; }
.file { margin:10px 0; }
.file .name { font-size:12px; color:var(--muted); margin-bottom:4px; word-break:break-all; }
.file img { max-width:100%; border:1px solid var(--border); border-radius:8px; display:block; }
a { color:var(--accent); }
@media (max-width: 760px) { main { grid-template-columns:1fr; height:auto; } #runs { border-right:none; border-bottom:1px solid var(--border); max-height:40vh; } }
</style>
</head>
<body>
<header>
  <h1>TOaD runs</h1>
  <span class="path" id="path"></span>
  <select id="project" aria-label="Project"><option value="">All projects</option></select>
  <button id="refresh">Refresh</button>
</header>
<main>
  <aside id="runs"><div class="empty">Loading…</div></aside>
  <section id="detail"><div class="empty">Select a run to see its report and receipts.</div></section>
</main>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = sel => document.querySelector(sel);
const badge = v => '<span class="badge ' + esc(String(v).toLowerCase()) + '">' + esc(v) + '</span>';
let current = null; // { project, id }
let projects = [];

async function loadProjects() {
  try { projects = await (await fetch('/api/projects')).json(); } catch (e) { projects = []; }
  const select = $('#project'), chosen = select.value;
  select.innerHTML = '<option value="">All projects</option>' + projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  select.value = projects.some(p => p.id === chosen) ? chosen : '';
  const one = projects.find(p => p.id === select.value);
  $('#path').textContent = one ? one.path : projects.length + ' project' + (projects.length === 1 ? '' : 's');
}

async function refresh() { await loadProjects(); await loadRuns(); }

async function loadRuns() {
  let runs;
  const only = $('#project').value;
  try { runs = await (await fetch('/api/runs' + (only ? '?project=' + encodeURIComponent(only) : ''))).json(); }
  catch (e) { $('#runs').innerHTML = '<div class="empty">Could not load runs.</div>'; return; }
  const box = $('#runs');
  if (!runs.length) {
    box.innerHTML = '<div class="empty">No runs yet.</div>';
    $('#detail').innerHTML = '<div class="empty">' + (projects.length ? 'Run a TOaD test, then refresh.' : 'No projects yet. Set one up with the setup_project tool.') + '</div>';
    return;
  }
  box.innerHTML = runs.map(r =>
    '<div class="run' + (current && r.id === current.id && r.project === current.project ? ' active' : '') + '" data-project="' + esc(r.project) + '" data-id="' + esc(r.id) + '">' +
      '<div class="time">' + esc(r.time) + '</div>' +
      '<div class="goal">' + esc(r.goal || r.target || '(no goal)') + '</div>' +
      '<div>' + badge(r.verdict) + '<span class="kind">' + esc(r.kind || '') + '</span>' + (only ? '' : '<span class="proj">' + esc(r.projectName) + '</span>') + '</div>' +
    '</div>').join('');
  box.querySelectorAll('.run').forEach(el => el.addEventListener('click', () => loadDetail(el.dataset.project, el.dataset.id)));
  if ((!current || !runs.some(r => r.id === current.id && r.project === current.project)) && runs.length) loadDetail(runs[0].project, runs[0].id);
}

async function loadDetail(project, id) {
  current = { project, id };
  document.querySelectorAll('#runs .run').forEach(el => el.classList.toggle('active', el.dataset.id === id && el.dataset.project === project));
  let d;
  try { d = await (await fetch(runUrl(project, id))).json(); }
  catch (e) { $('#detail').innerHTML = '<div class="empty">Could not load this run.</div>'; return; }
  const h = d.handoff || {};
  const scenarios = (h.request && h.request.scenarios) || [];
  const target = d.handoff && d.handoff.kind === 'web' ? (h.target && h.target.url) : d.handoff && d.handoff.kind === 'cli' ? ((h.target && h.target.workdir) + (h.target && h.target.program ? ' — ' + h.target.program : '')) : '';
  $('#detail').innerHTML =
    '<h2>' + esc(h.request && h.request.goal ? h.request.goal : 'Run ' + id) + '</h2>' +
    '<div class="meta">' + badge(d.verdict) +
      '<span class="time">' + esc(d.time) + '</span>' +
      '<span class="kind" title="' + esc(d.projectPath) + '">' + esc(d.projectName) + '</span>' +
      (h.kind ? '<span class="kind">' + esc(h.kind) + '</span>' : '') +
      (d.status && d.status !== 'ok' ? '<span class="status">status: ' + esc(d.status) + '</span>' : '') +
    '</div>' +
    (target ? '<div class="field"><span class="label">Target:</span> ' + esc(target) + '</div>' : '') +
    (scenarios.length ? '<h3>Scenarios</h3>' + scenarios.map(s => '<div class="scenario"><div class="name">' + esc(s.name) + '</div><div class="steps">Steps: ' + esc(s.steps) + '</div><div class="expected">Expected: ' + esc(s.expected) + '</div></div>').join('') : '') +
    '<h3>Report</h3><pre>' + esc(d.report || 'No report') + '</pre>' +
    (d.files.length ? '<h3>Receipts</h3>' + d.files.map(f => fileNode(project, id, f)).join('') : '');
  document.querySelectorAll('pre[data-text]').forEach(async el => {
    try { const res = await fetch(el.dataset.text); el.textContent = await res.text(); }
    catch (e) { el.textContent = '(failed to load)'; }
  });
}

function runUrl(project, id) { return '/api/projects/' + encodeURIComponent(project) + '/runs/' + encodeURIComponent(id); }

function fileNode(project, id, rel) {
  const lower = rel.toLowerCase();
  const url = runUrl(project, id) + '/file/' + encodeURIComponent(rel);
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return '<div class="file"><div class="name">' + esc(rel) + '</div><img loading="lazy" src="' + url + '" alt="' + esc(rel) + '"></div>';
  if (/\.(txt|md|json|log|ya?ml|html|css|js|sh)$/.test(lower)) return '<div class="file"><div class="name">' + esc(rel) + '</div><pre data-text="' + esc(url) + '"></pre></div>';
  return '<div class="file"><div class="name">' + esc(rel) + '</div><a href="' + url + '" download>Download</a></div>';
}

$('#refresh').addEventListener('click', refresh);
$('#project').addEventListener('change', () => { current = null; refresh(); });
window.addEventListener('focus', refresh);
refresh();
</script>
</body>
</html>
`;
