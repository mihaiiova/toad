/**
 * Bounded web scenario recording: an ordered sequence of navigation, clicks,
 * fills and explicit assertions, each element found by a stable locator (an
 * ARIA role and accessible name, a label, or exact text). No video, no
 * selectors, no arbitrary code, no credentials.
 *
 * Literal URLs, fill values and expected text are trusted, non-secret test
 * fixtures. Anything that looks like a credential (a password, token or
 * sign-in field, a password-type input) is refused, never recorded.
 *
 * Runs are deterministic and make no model call: the same Playwright MCP
 * server the web-tester uses (same version, same browser) is started fresh
 * and isolated, and one fixed script, with the payload as data, drives it.
 */
import { spawn } from 'node:child_process';
import { artifactReference, beginExecution, executionContext, executionOutputPath, finishExecution, noteExecutionError, operationReceipt } from './toad-execution.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_CODEC = 'web-scenario-v1';
export const MAX_WEB_STEPS = 30;
const MAX_STEP_CHARS = 4096;
const MAX_CANDIDATE_BYTES = 16 * 1024;

const ROLES = new Set(['alert', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'dialog', 'heading', 'img', 'link', 'list', 'listitem', 'menuitem', 'navigation', 'option', 'radio', 'region', 'row', 'searchbox', 'spinbutton', 'status', 'switch', 'tab', 'textbox']);
const ACTIONS = new Set(['goto', 'click', 'fill']);
const ASSERTIONS = new Set(['expectVisible', 'expectText', 'expectUrl']);
// Fields and controls a credential-free scenario has no business touching.
const SENSITIVE = /\b(pass(word|code|phrase)?|secret|token|api[ _-]?key|otp|one[- ]time|2fa|mfa|pin (code|number)|cvv|cvc|credit card|card number|ssn|log ?in|sign ?in|username|auth|authenticat\w*|authori[sz]\w*|session|cookie)\b/i;

const keys = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.slice().sort().join(',');
const literal = (v, max = 256) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const name = v => literal(v) && v.trim().length > 0;

/** A locator: { role, name } | { label } | { text }, always matched exactly. */
export function validLocator(t) {
  if (keys(t, ['role', 'name'])) return ROLES.has(t.role) && name(t.name) && !SENSITIVE.test(t.name);
  if (keys(t, ['label'])) return name(t.label) && !SENSITIVE.test(t.label);
  if (keys(t, ['text'])) return name(t.text) && !SENSITIVE.test(t.text);
  return false;
}

/** An absolute http(s) URL with no user info, fragment or credential-like query names. */
export function validWebUrl(url) {
  if (!literal(url, 2048) || !url) return false;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || url.includes('#')) return false;
    return ![...u.searchParams.keys()].some(k => SENSITIVE.test(k.replace(/[_-]/g, ' ')) || /token|key|secret|pass|auth|session|code/i.test(k));
  } catch { return false; }
}

function locatorIssue(target) {
  if (validLocator(target)) return null;
  if (keys(target, ['role', 'name'])) return [ROLES.has(target.role) ? 'name' : 'role'];
  if (keys(target, ['label'])) return ['label'];
  if (keys(target, ['text'])) return ['text'];
  return [];
}

function stepIssue(s) {
  if (!s || typeof s !== 'object' || !ACTIONS.has(s.action) && !ASSERTIONS.has(s.action)) return ['action'];
  const shape = { goto: ['action', 'url'], click: ['action', 'target'], fill: ['action', 'target', 'value'], expectVisible: ['action', 'target'], expectText: ['action', 'target', 'contains'], expectUrl: ['action', 'path'] }[s.action];
  if (!keys(s, shape)) return [];
  if (shape.includes('target')) {
    const path = locatorIssue(s.target);
    if (path) return ['target', ...path];
  }
  switch (s.action) {
    case 'goto': return validWebUrl(s.url) ? null : ['url'];
    case 'click': case 'expectVisible': return null;
    case 'fill': return literal(s.value, 1024) && !SENSITIVE.test(s.value) ? null : ['value'];
    case 'expectText': return name(s.contains) && s.contains.length <= 1024 ? null : ['contains'];
    case 'expectUrl': return literal(s.path, 2048) && s.path.startsWith('/') && !s.path.startsWith('//') && !s.path.includes('#') ? null : ['path'];
  }
}

/**
 * { steps: [...] }: 2 to 30 ordered steps, starting with a goto and ending
 * with an assertion, so every recording checks something it observed.
 */
export function webPayloadIssue(p) {
  if (!keys(p, ['steps'])) return [];
  if (!Array.isArray(p.steps) || p.steps.length < 2 || p.steps.length > MAX_WEB_STEPS) return ['steps'];
  for (let i = 0; i < p.steps.length; i++) {
    const path = stepIssue(p.steps[i]);
    if (path) return ['steps', i, ...path];
  }
  if (p.steps[0].action !== 'goto') return ['steps', 0, 'action'];
  if (!ASSERTIONS.has(p.steps.at(-1).action)) return ['steps', p.steps.length - 1, 'action'];
  return null;
}
export function validWebPayload(p) { return webPayloadIssue(p) === null; }

/** Whether `url` is the base or under it, by whole path segment, on the same origin. */
export function underBase(url, base) {
  if (typeof url !== 'string' || typeof base !== 'string') return false;
  try {
    const target = new URL(url), parent = new URL(base);
    if (target.origin !== parent.origin || target.username || target.password) return false;
    const root = parent.pathname.replace(/\/+$/, '') || '/';
    return root === '/' || target.pathname === root || target.pathname.startsWith(`${root}/`);
  } catch { return false; }
}

/** Every navigation of the payload stays under the target URL. */
export function webPayloadUnder(p, base) {
  return validWebPayload(p) && p.steps.filter(s => s.action === 'goto').every(s => underBase(s.url, base));
}

/** Resolve target-relative navigation without changing assertions or prose. */
export function bindWebTarget(payload, targetUrl) {
  if (!validWebUrl(targetUrl) || !keys(payload, ['steps']) || !Array.isArray(payload.steps)) throw new Error('Invalid web target');
  const steps = payload.steps.map(step => {
    if (step?.action !== 'goto') return step;
    const value = step.url;
    const url = typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
      ? new URL(value, targetUrl).href : value;
    return {...step, url};
  });
  const bound = {steps};
  if (!webPayloadUnder(bound, targetUrl)) throw new Error('Web navigation is outside the run target');
  return bound;
}

const show = t => t.role ? `${t.role} ${JSON.stringify(t.name)}` : t.label ? `label ${JSON.stringify(t.label)}` : `text ${JSON.stringify(t.text)}`;
export function stepText(s) {
  switch (s.action) {
    case 'goto': return `open ${s.url}`;
    case 'click': return `click ${show(s.target)}`;
    case 'fill': return `fill ${show(s.target)} with ${JSON.stringify(s.value)}`;
    case 'expectVisible': return `${show(s.target)} is visible`;
    case 'expectText': return `${show(s.target)} contains ${JSON.stringify(s.contains)}`;
    case 'expectUrl': return `the URL path is ${JSON.stringify(s.path)}`;
  }
  throw new Error('Unknown web step');
}

/**
 * Readable steps: the actions since the last check, then the checks that
 * follow them. A payload starts with an action and ends with a check.
 */
export function webDescription(p) {
  const out = [];
  let actions = [], checks = [];
  for (const s of p.steps) {
    if (ACTIONS.has(s.action)) {
      if (checks.length) { out.push({ action: actions.join('; '), assertion: checks.join('; ') }); actions = []; checks = []; }
      actions.push(stepText(s));
    } else checks.push(stepText(s));
  }
  out.push({ action: actions.join('; '), assertion: checks.join('; ') });
  return out;
}

export const payloadHash = p => createHash('sha256').update(JSON.stringify(p), 'utf8').digest('hex');

/** The receipt the structured web runner writes, exactly; a finalizer recomputes it. */
export function webReceipt(p, outcome) {
  const lines = [WEB_CODEC, `payload: sha256 ${payloadHash(p)}`, ...p.steps.map((s, i) => `${String(i + 1).padStart(2, '0')}. ${stepText(s)}`)];
  if (outcome.result === 'PASS') lines.push('result: PASS');
  else lines.push(`result: ${outcome.result}${Number.isInteger(outcome.step) ? ` at step ${outcome.step + 1}` : ''}: ${outcome.message ?? 'no detail'}`);
  return lines.join('\n') + '\n';
}

/** The candidate a passing capture leaves beside its receipt, within the finalizer's limits. */
export function webCandidateFits(p, scenarioName) {
  return Buffer.byteLength(JSON.stringify({ version: 1, scenarioName, payload: p }) + '\n', 'utf8') <= MAX_CANDIDATE_BYTES &&
    webDescription(p).every(s => s.action.length <= MAX_STEP_CHARS && s.assertion.length <= MAX_STEP_CHARS);
}

/**
 * The fixed script the Playwright MCP runs with the page. It sees only
 * `page` and JavaScript built-ins; the payload is JSON data inside it. Its
 * answer is hex-encoded behind a per-run nonce, so nothing the page shows
 * can be read as the result. Messages are fixed strings: no page text.
 */
export function webScript(p, nonce, stepMs = 10000, targetUrl = new URL(p.steps[0].url).origin) {
  return `async (page) => {
  const P = ${JSON.stringify(p)};
  const N = ${JSON.stringify(nonce)};
  const T = ${Number(stepMs)};
  const hex = s => { let o = ''; for (const c of s) o += c.codePointAt(0).toString(16).padStart(6, '0'); return o; };
  const steps = [];
  const finishStep = result => { const s = steps.at(-1); if (s && !s.finishedAt) { s.finishedAt = new Date().toISOString(); s.outcome = result === 'PASS' && !s.assertion ? 'completed' : result; if (s.assertion) s.assertion.result = result === 'PASS' ? 'PASS' : result === 'FAIL' ? 'FAIL' : 'ERROR'; } };
  const done = v => { finishStep(v.result); return ['TOADWEB', N, hex(JSON.stringify({...v, steps})), 'END'].join('-'); };
  const loc = t => t.role ? page.getByRole(t.role, { name: t.name, exact: true }) : t.label ? page.getByLabel(t.label, { exact: true }) : page.getByText(t.text, { exact: true });
  const until = async check => { const end = Date.now() + T; for (;;) { try { if (await check()) return true; } catch {} if (Date.now() > end) return false; await page.waitForTimeout(100); } };
  const one = async l => (await l.count()) === 1;
  const base = new URL(${JSON.stringify(targetUrl)});
  const under = value => { const u = new URL(value); const root = base.pathname.replace(/\\/+$/, '') || '/'; return u.origin === base.origin && !u.username && !u.password && (root === '/' || u.pathname === root || u.pathname.startsWith(root + '/')); };
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest() && !under(request.url())) await route.abort();
    else await route.continue();
  });
  const sensitive = l => l.evaluate(e => { const t = String(e.getAttribute('type') || '').toLowerCase(); const a = String(e.getAttribute('autocomplete') || '').toLowerCase(); return ['password', 'hidden', 'file'].includes(t) || /password|one-time-code|cc-|webauthn|username/.test(a); });
  for (let i = 0; i < P.steps.length; i++) {
    finishStep('PASS');
    const s = P.steps[i];
    steps.push({index:i+1, operation:s.action, startedAt:new Date().toISOString(), finishedAt:null, outcome:'running', assertion:s.action.startsWith('expect') ? {kind:s.action,result:'ERROR'} : null});
    if (s.action === 'goto') {
      let r;
      try { r = await page.goto(s.url, { timeout: T * 3, waitUntil: 'load' }); } catch { return done({ result: 'ERROR', step: i, message: 'the page could not be loaded' }); }
      if (r && r.status() >= 400) return done({ result: 'FAIL', step: i, message: 'the page answered HTTP ' + r.status() });
      continue;
    }
    const l = s.target ? loc(s.target) : null;
    if (s.action === 'click' || s.action === 'fill') {
      if (!await until(async () => (await one(l)) && await l.isVisible())) return done({ result: 'FAIL', step: i, message: 'no single visible element matches' });
      if (s.action === 'fill' && await sensitive(l)) return done({ result: 'UNSAFE', step: i, message: 'the field is credential-like; it is never filled' });
      try { if (s.action === 'click') await l.click({ timeout: T }); else await l.fill(s.value, { timeout: T }); }
      catch { return done({ result: 'FAIL', step: i, message: 'the element could not be ' + (s.action === 'click' ? 'clicked' : 'filled') }); }
      continue;
    }
    let ok;
    if (s.action === 'expectVisible') ok = await until(async () => (await one(l)) && await l.isVisible());
    else if (s.action === 'expectText') ok = await until(async () => (await one(l)) && (await l.innerText()).includes(s.contains));
    else ok = await until(async () => { const m = /^[a-z][a-z0-9+.-]*:\\/\\/[^/?#]*([^#]*)/i.exec(page.url()); return (m ? m[1] || '/' : '') === s.path; });
    if (!ok) return done({ result: 'FAIL', step: i, message: 'the assertion did not hold' });
  }
  return done({ result: 'PASS' });
}`;
}

/** Decode the runner's answer from the tool text: exactly one marker with this nonce. */
export function decodeWebAnswer(text, nonce, includeSteps = false) {
  const found = [...String(text).matchAll(new RegExp(`TOADWEB-${nonce}-([0-9a-f]+)-END`, 'g'))];
  if (found.length !== 1 || found[0][1].length % 6) return null;
  let json = '';
  for (let i = 0; i < found[0][1].length; i += 6) json += String.fromCodePoint(parseInt(found[0][1].slice(i, i + 6), 16));
  try {
    const v = JSON.parse(json);
    if (!['PASS', 'FAIL', 'ERROR', 'UNSAFE'].includes(v?.result)) return null;
    return { result: v.result, ...(Number.isInteger(v.step) ? { step: v.step } : {}), ...(typeof v.message === 'string' ? { message: v.message.slice(0, 200) } : {}), ...(includeSteps && Array.isArray(v.steps) ? { steps: v.steps } : {}) };
  } catch { return null; }
}

/**
 * The browser driver: the agent's own Playwright MCP launcher and arguments,
 * from .pi/mcp.json. TOAD_WEB_DRIVER (a JSON array: command, args...) stands
 * in a fake for Toad's own tests, as TOAD_PI does for Pi.
 */
export function webDriver(env = process.env) {
  if (env.TOAD_WEB_DRIVER) {
    const v = JSON.parse(env.TOAD_WEB_DRIVER);
    if (!Array.isArray(v) || !v.length || !v.every(x => typeof x === 'string' && x)) throw new Error('TOAD_WEB_DRIVER must be a JSON array of strings');
    return { command: v[0], args: v.slice(1), cwd: process.cwd() };
  }
  const config = JSON.parse(readFileSync(join(here, '..', '.pi', 'mcp.json'), 'utf8')).mcpServers?.playwright;
  if (config?.command !== 'node' || !Array.isArray(config.args) || config.args[0] !== 'tools/playwright-mcp.mjs') throw new Error('The Playwright MCP configuration is not the one Toad ships');
  return { command: process.execPath, args: [join(here, 'playwright-mcp.mjs'), ...config.args.slice(1)], cwd: join(here, '..') };
}

/** One newline-delimited JSON-RPC session with an MCP server over stdio. */
function mcpSession(driver, env, signal) {
  const posix = process.platform !== 'win32';
  const child = spawn(driver.command, driver.args, { cwd: driver.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: posix });
  const pending = new Map();
  let buffer = '', next = 1, closed = false;
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  const send = message => { if (!closed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const exited = new Promise(resolve => child.on('close', () => { closed = true; fail(new Error('the browser driver exited')); resolve(); }));
  child.on('error', error => { closed = true; fail(error); });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { buffer = ''; fail(new Error('the browser driver sent too much')); stop(); return; }
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m?.method && m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
      else if (m?.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(String(m.error.message ?? 'driver error').slice(0, 200))); else p.resolve(m.result);
      }
    }
  });
  const kill = sig => { try { if (posix) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
  async function stop() {
    if (!closed) { try { child.stdin.end(); } catch {} }
    const wait = ms => Promise.race([exited, new Promise(r => setTimeout(r, ms).unref())]);
    await wait(3000);
    kill('SIGTERM');
    await wait(3000);
    kill('SIGKILL');
  }
  // The owner gets a short diagnostic window before closing the process.
  const onAbort = () => { fail(new Error('cancelled or timed out')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const request = (method, params, ms, diagnostic = false) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('the browser driver is not running'));
    if (signal?.aborted && !diagnostic) return reject(new Error('cancelled or timed out'));
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
    timer.unref();
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { request, notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }), close: async () => { signal?.removeEventListener('abort', onAbort); await stop(); } };
}

/**
 * Run a web payload in a fresh, isolated browser and check it. Resolves with
 * { result: PASS | FAIL | ERROR | UNSAFE, step?, message? }; never throws.
 * The browser gets no secrets file, and its own scratch output folder.
 */
export async function runWebPayload(p, { env = process.env, signal, screenshot, targetUrl, startMs = 180000, execution, receipt } = {}) {
  if (targetUrl) {
    try { p = bindWebTarget(p, targetUrl); } catch { return {result:'ERROR',message:'web navigation is outside the run target'}; }
  }
  if (!validWebPayload(p)) return { result: 'ERROR', message: 'invalid web recording payload' };
  let scratch, session, handle, names = [], outcome, observedSteps = [];
  const captures = [], artifacts = [];
  try {
    const context = execution ?? executionContext(env, env.TOAD_EXECUTION_SCENARIO_NAME);
    handle = beginExecution(context, 'structured_web');
    const driver = webDriver(env);
    scratch = mkdtempSync(join(tmpdir(), 'toad-web-'));
    const secrets = join(scratch, 'no-secrets.env');
    writeFileSync(secrets, '', { mode: 0o600 });
    const childEnv = { ...env, TOAD_RECEIPTS_DIR: join(scratch, 'output'), TOAD_PLAYWRIGHT_SECRETS_FILE: secrets };
    // Structured execution owns its record; its inner transport must not double-record.
    for (const k of ['TOAD_CLI_SECRETS_FILE', 'TOAD_RECORDING_ENABLED', 'TOAD_WEB_DRIVER', 'TOAD_EXECUTION_RUN_DIR']) delete childEnv[k];
    session = mcpSession(driver, childEnv, signal);
    await session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'toad-web-recording', version: '1' } }, startMs);
    session.notify('notifications/initialized');
    const listed = await session.request('tools/list', {}, 30000);
    names = (listed.tools ?? []).map(t => t?.name);
    const tool = ['browser_run_code_unsafe', 'browser_run_code'].find(n => names.includes(n));
    if (!tool) throw new Error('the browser driver cannot run a scripted scenario');
    const nonce = randomBytes(16).toString('hex');
    const stepMs = Number(env.TOAD_WEB_STEP_TIMEOUT_MS) > 0 ? Math.min(Number(env.TOAD_WEB_STEP_TIMEOUT_MS), 10000) : 10000;
    const called = await session.request('tools/call', { name: tool, arguments: { code: webScript(p, nonce, stepMs, targetUrl) } }, 60000 + p.steps.length * 40000);
    const text = (called?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
    const decoded = decodeWebAnswer(text, nonce, true);
    observedSteps = decoded?.steps ?? [];
    if (decoded) { const { steps, ...result } = decoded; outcome = result; }
    else outcome = { result: 'ERROR', message: called?.isError ? 'the browser driver reported an error' : 'the browser driver returned no result' };
  } catch {
    // Driver exceptions can contain page text/credentials. Persist only fixed classifications.
    outcome = { result: 'ERROR', message: signal?.aborted ? 'cancelled or timed out' : 'the browser could not run' };
  } finally {
    if (session) {
      const diagnostic = async (kind, tool, args, save) => {
        if (!names.includes(tool)) { captures.push({ kind, status: 'unavailable' }); return; }
        try {
          const response = await session.request('tools/call', { name: tool, arguments: args }, 1000, true);
          if (response?.isError) throw new Error();
          if (save) await save(response);
          captures.push({ kind, status: 'saved' });
        } catch { captures.push({ kind, status: 'error' }); }
      };
      // Capture failure state before any receipt finalization or session close, including cancellation.
      if (screenshot) await diagnostic('screenshot', 'browser_take_screenshot', { filename: 'toad-screenshot.png' }, () => {
        const image = readFileSync(join(scratch, 'output', 'toad-screenshot.png'));
        if (image.length > 16 * 1024 * 1024) throw new Error();
        if (handle) executionOutputPath(handle.run, screenshot);
        writeFileSync(screenshot, image, { flag: 'wx', mode: 0o600 });
        if (handle) artifacts.push(artifactReference(handle.run, screenshot, 'screenshot'));
      });
      if (handle && outcome?.result !== 'PASS') {
        for (const [kind, tool] of [['hierarchy', 'browser_snapshot'], ['console', 'browser_console_messages']]) {
          await diagnostic(kind, tool, {}, response => {
            const dir = join(handle.run, 'execution-artifacts');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const file = join(dir, `${handle.record.id}-${kind}.txt`);
            // Structured scenarios are credential-free; diagnostics remain sensitive artifacts, not metadata.
            const text = (response.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
            executionOutputPath(handle.run, file);
            writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
            artifacts.push(artifactReference(handle.run, file, kind));
          });
        }
      }
      await session.close();
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  outcome ??= { result: 'ERROR', message: 'the browser could not run' };
  if (handle) {
    try {
      if (receipt) {
        executionOutputPath(handle.run, receipt);
        writeFileSync(receipt, webReceipt(p, outcome), { flag: 'wx', mode: 0o600 });
        artifacts.unshift(artifactReference(handle.run, receipt, 'receipt'));
      } else artifacts.unshift(operationReceipt(handle, outcome.result));
      finishExecution(handle, { outcome: signal?.aborted ? 'cancelled' : outcome.result === 'UNSAFE' ? 'ERROR' : outcome.result,
        steps: observedSteps, assertion: observedSteps.findLast(s => s.assertion)?.assertion ?? null, artifacts, captures, evidenceComplete: true });
    } catch {
      // Preserve an observed failure even when its mandatory receipt is unavailable.
      try { finishExecution(handle, { outcome: outcome.result === 'FAIL' ? 'FAIL' : 'ERROR', steps: observedSteps, captures, artifacts, evidenceComplete: false }); } catch { /* initial running record remains incomplete */ }
      if (outcome.result !== 'FAIL') outcome = { result: 'ERROR', message: 'required web evidence could not be saved' };
    }
  } else if (env.TOAD_EXECUTION_RUN_DIR || execution) {
    noteExecutionError(execution?.run ?? env.TOAD_EXECUTION_RUN_DIR);
    outcome = { result: 'ERROR', message: 'required web execution record could not be created' };
  }
  return outcome;
}

/** Replay shares exactly the structured capture executor and immutable proof receipt. */
export async function replayWebPayload(p, { receipts, name = '01-replay', env, signal, targetUrl, execution }) {
  if (!validWebPayload(p)) throw new Error('Invalid web recording payload');
  mkdirSync(receipts, { recursive: true });
  const receipt = join(receipts, `${name}.txt`);
  const outcome = await runWebPayload(p, { env, signal, targetUrl, execution, receipt, screenshot: join(receipts, `${name}.png`) });
  if (!execution && !(env ?? process.env).TOAD_EXECUTION_RUN_DIR) writeFileSync(receipt, webReceipt(p, outcome), { mode: 0o600 });
  return { ...outcome, result: outcome.result === 'PASS' || outcome.result === 'FAIL' ? outcome.result : 'ERROR', receipt };
}
