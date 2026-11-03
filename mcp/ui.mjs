/**
 * Toad run viewer: one localhost web interface over the runs of every project
 * Toad has been set up in (the list in ~/.config/toad/projects.json).
 *
 *   toad ui                # http://127.0.0.1:8787, or the next free port
 *   toad ui --port 9000    # exactly this port
 *
 * The page is ui.html; this file serves it and a small JSON API. It binds to
 * localhost only; run artifacts can contain sensitive data.
 */
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects } from './projects.mjs';
import { VERSION } from './agent.mjs';

const HOST = '127.0.0.1';
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');

// Receipts are evidence, not pages: anything that could run in the browser is served as text.
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.svg': 'text/plain; charset=utf-8',
};

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function readText(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }
function mtime(path) { try { return statSync(path).mtimeMs; } catch { return null; } }

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

/** The start time encoded in a run id, as epoch milliseconds. */
function startOf(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function targetOf(handoff) {
  if (!handoff) return '';
  if (handoff.kind === 'web') return handoff.target?.url ?? '';
  if (handoff.kind === 'cli') return [handoff.target?.program, handoff.target?.image && `in ${handoff.target.image}`].filter(Boolean).join(' ');
  return '';
}

/**
 * One run's summary. `state` is running, waiting, finished, or interrupted
 * (no report, and the server that started it is gone). Runs from before
 * state.json existed count as finished when they have a report.
 */
function summary(project, id) {
  const dir = join(project.runs, id);
  const handoff = readJson(join(dir, 'handoff.yaml'));
  const reportPath = join(dir, 'reports', 'report.md');
  const report = readText(reportPath);
  const saved = readJson(join(dir, 'state.json'));
  const started = Date.parse(saved?.started ?? '') || startOf(id);
  let state = report ? 'finished' : saved && ['running', 'waiting'].includes(saved.state) && alive(saved.pid) ? saved.state : 'interrupted';
  if (!report && !saved && started && Date.now() - started < 60 * 60 * 1000) state = 'running';
  const ended = report ? Date.parse(saved?.finished ?? '') || mtime(reportPath) : null;
  // The server records the verdict it read; older runs only have the report.
  const verdict = state !== 'finished' ? state.toUpperCase()
    : saved?.verdict ?? /^[#*\s]*Verdict[*:\s]*?(?:\n\s*)*[*\s]*(PASS|FAIL|ERROR)\b/im.exec(report)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  return {
    id, project: project.id, projectName: project.name,
    started, ended, duration: started && ended ? ended - started : null,
    kind: handoff?.kind ?? '', goal: handoff?.request?.goal ?? '', target: targetOf(handoff),
    scenarios: handoff?.request?.scenarios?.length ?? 0,
    verdict, status: /^Status:\s*(\S+)/m.exec(report)?.[1] ?? (state === 'finished' ? 'unknown' : state), state,
  };
}

function listRuns(project) { return runDirs(project).map(id => summary(project, id)); }

/** Each project with its latest run and recent verdicts, for the sidebar and overview. */
function projectSummaries() {
  return projects().map(project => {
    const runs = listRuns(project);
    const finished = runs.filter(r => r.state === 'finished');
    return {
      id: project.id, name: project.name, path: project.path,
      runs: runs.length, active: runs.filter(r => r.state === 'running' || r.state === 'waiting').length,
      passed: finished.filter(r => r.verdict === 'PASS').length, finished: finished.length,
      last: runs[0] ?? null, recent: runs.slice(0, 20).map(r => ({ id: r.id, verdict: r.verdict, started: r.started, goal: r.goal })),
    };
  }).sort((a, b) => (b.last?.started ?? 0) - (a.last?.started ?? 0));
}

function receiptFiles(dir) {
  const files = [];
  const receipts = join(dir, 'receipts');
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({ path: path.slice(dir.length + 1), size: statSync(path).size });
    }
  }
  try { if (existsSync(receipts)) visit(receipts); } catch { /* unreadable receipts are omitted */ }
  return files;
}

function detail(project, id) {
  const dir = requireRun(project, id);
  const runs = runDirs(project);
  const at = runs.indexOf(id);
  return {
    ...summary(project, id), projectPath: project.path,
    handoff: readJson(join(dir, 'handoff.yaml')) ?? {},
    report: readText(join(dir, 'reports', 'report.md')),
    files: receiptFiles(dir),
    newer: runs[at - 1] ?? null, older: runs[at + 1] ?? null,
  };
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
    'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function sendPage(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(readFileSync(PAGE, 'utf8').replace('__VERSION__', VERSION));
}

function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname;
    if (path === '/') return sendPage(res);
    if (path === '/api/projects') return sendJson(res, projectSummaries());
    if (path === '/api/runs') {
      const only = url.searchParams.get('project');
      return sendJson(res, projects().filter(p => !only || p.id === only).flatMap(listRuns).sort((a, b) => b.id.localeCompare(a.id)));
    }
    let m;
    if ((m = /^\/api\/projects\/([0-9a-f]{12})\/runs$/.exec(path))) return sendJson(res, listRuns(requireProject(m[1])));
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
