/** A recording stdio relay for the already-owned Playwright MCP process. No browser executor. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactReference, beginExecution, executionContext, executionOutputPath, finishExecution, noteExecutionError, operationReceipt } from './toad-execution.mjs';

const BIND = 'browser_toad_bind_scenario';
const MAX = 16 * 1024 * 1024;
export function relayWebTransport(child, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
  let context, closed = false, incoming = '', outgoing = '';
  const pending = new Map(), internal = new Map(), finished = new Set(), finalizing = new Set();
  let knownTools = new Set();
  const operationMs = Number(env.TOAD_WEB_OPERATION_TIMEOUT_MS) > 0 ? Math.min(Number(env.TOAD_WEB_OPERATION_TIMEOUT_MS), 120000) : 120000;
  const send = m => output.write(JSON.stringify(m) + '\n');
  const forward = m => { if (!closed) child.stdin.write(JSON.stringify(m) + '\n'); };
  const error = (id, message) => {
    noteExecutionError(env.TOAD_EXECUTION_RUN_DIR);
    send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } });
  };
  const diagnostic = (name, args) => new Promise((resolve, reject) => {
    if (closed || !knownTools.has(name)) return reject(new Error());
    const id = `toad-diagnostic-${randomUUID()}`;
    const timer = setTimeout(() => { internal.delete(id); reject(new Error()); }, 750);
    internal.set(id, value => { clearTimeout(timer); value?.isError ? reject(new Error()) : resolve(value); });
    forward({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });
  async function capture(handle) {
    const captures = [], artifacts = [];
    // Raw hierarchy/console may include credentials; ordinary transport records no arguments/results.
    // Screenshots remain sensitive, as with the existing browser receipt policy.
    for (const kind of ['hierarchy', 'console']) captures.push({ kind, status: 'unavailable' });
    if (!knownTools.has('browser_take_screenshot')) return { captures: [...captures, { kind: 'screenshot', status: 'unavailable' }], artifacts };
    try {
      const dir = join(handle.run, 'receipts');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw new Error();
      const file = join(dir, `toad-diagnostic-${handle.record.id}.png`);
      executionOutputPath(handle.run, file);
      const response = await diagnostic('browser_take_screenshot', { filename: file });
      // Playwright saves the requested file; image blocks alone are not durable evidence.
      if (readFileSync(file).length > 16 * 1024 * 1024) throw new Error();
      artifacts.push(artifactReference(handle.run, file, 'screenshot'));
      captures.push({ kind: 'screenshot', status: 'saved' });
    } catch { captures.push({ kind: 'screenshot', status: 'error' }); }
    return { captures, artifacts };
  }
  async function complete(entry, response, cancelled = false) {
    const { handle, id } = entry;
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    pending.delete(JSON.stringify(id));
    finished.add(JSON.stringify(id));
    const failed = cancelled || !!response?.error || !!response?.result?.isError;
    const outcome = cancelled ? 'cancelled' : failed ? 'ERROR' : 'completed';
    const bundle = failed ? await capture(handle) : { artifacts: [], captures: [] };
    try {
      bundle.artifacts.unshift(operationReceipt(handle, outcome));
      finishExecution(handle, { outcome, ...bundle, evidenceComplete: true });
    } catch {
      if (!cancelled) return error(id, 'ERROR: required web operation evidence could not be saved; stop this scenario.');
    }
    if (!cancelled) {
      const receipt = bundle.artifacts.find(a => a.kind === 'receipt');
      if (response?.result && receipt) response = { ...response, result: { ...response.result, content: [...(response.result.content ?? []), { type: 'text', text: `Toad operation receipt: ${join(handle.run, receipt.path)}. Operation completion is not a scenario assertion.` }] } };
      send(response);
    }
  }
  function finalize(entry, response, cancelled = false) {
    const work = complete(entry, response, cancelled);
    finalizing.add(work);
    work.then(() => finalizing.delete(work), () => {
      finalizing.delete(work);
      error(entry.id, 'ERROR: web operation finalization failed; stop this scenario.');
    });
    return work;
  }
  function bind(m) {
    if (context) return error(m.id, 'ERROR: this browser session is already bound; use a new tester/session for another scenario.');
    try {
      context = executionContext(env, m.params?.arguments?.scenarioName);
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Bound web evidence to scenario ${context.scenarioName}. Tool success is not a scenario assertion.` }] } });
    } catch { error(m.id, 'ERROR: bind an exact declared scenarioName before using browser tools (or an explicit bounded name for a goal-only run).'); }
  }
  function fromCaller(m) {
    if (m.method === 'notifications/cancelled') {
      const entry = pending.get(JSON.stringify(m.params?.requestId));
      if (entry) void finalize(entry, null, true);
    }
    if (m.method === 'tools/call') {
      if (stopping) return error(m.id, 'ERROR: this browser session is stopping; start a new scenario attempt.');
      if (m.params?.name === BIND) return bind(m);
      if (!context) return error(m.id, 'ERROR: call browser_toad_bind_scenario with the exact scenarioName before browser operations.');
      try {
        const key = JSON.stringify(m.id);
        if (pending.has(key)) throw new Error();
        const handle = beginExecution(context, m.params?.name);
        const entry = { handle, id: m.id };
        entry.timer = setTimeout(async () => {
          await finalize(entry, { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'ERROR: browser operation timed out; the owned session is stopping.' }] } });
          void shutdown();
        }, operationMs);
        pending.set(key, entry);
      } catch { return error(m.id, 'ERROR: required web execution record could not be created; stop this scenario.'); }
    }
    forward(m);
  }
  function fromServer(m) {
    // Server-initiated requests use their own ID namespace, even when an ID
    // equals an outstanding caller request. Never mistake them for results.
    if (m.method) { send(m); return; }
    if (internal.has(m.id)) { const resolve = internal.get(m.id); internal.delete(m.id); resolve(m.result); return; }
    if (m.result?.tools && Array.isArray(m.result.tools)) {
      knownTools = new Set(m.result.tools.map(t => t.name));
      m.result.tools.push({ name: BIND, description: 'Call FIRST for this tester session, with its exact scenario name. Binds operation evidence once; unknown names and rebinding are errors. Tool completion never proves a scenario assertion.', inputSchema: { type: 'object', properties: { scenarioName: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['scenarioName'], additionalProperties: false } });
    }
    if (finished.has(JSON.stringify(m.id))) return; // A late result cannot overwrite a timed-out operation.
    const entry = pending.get(JSON.stringify(m.id));
    if (entry) { void finalize(entry, m); return; }
    send(m);
  }
  input.setEncoding('utf8').on('data', chunk => {
    incoming += chunk;
    if (incoming.length > MAX) { incoming = ''; void shutdown(); return; }
    for (let i; (i = incoming.indexOf('\n')) >= 0;) {
      const line = incoming.slice(0, i); incoming = incoming.slice(i + 1);
      try { fromCaller(JSON.parse(line)); } catch { /* Invalid protocol input is never executed. */ }
    }
  });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    outgoing += chunk;
    if (outgoing.length > MAX) { outgoing = ''; void shutdown(); return; }
    for (let i; (i = outgoing.indexOf('\n')) >= 0;) {
      const line = outgoing.slice(0, i); outgoing = outgoing.slice(i + 1);
      try { fromServer(JSON.parse(line)); } catch { /* Only JSON-RPC is relayed. */ }
    }
  });
  child.stdin.on('error', () => {});
  let stopping;
  function shutdown() {
    stopping ??= (async () => {
      await Promise.allSettled([...pending.values()].map(entry => finalize(entry, null, true)));
      await Promise.allSettled([...finalizing]);
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      timer.unref();
      child.kill('SIGTERM');
    })();
    return stopping;
  }
  input.on('end', () => { void shutdown(); });
  child.on('exit', () => {
    closed = true;
    for (const entry of pending.values()) {
      entry.done = true; clearTimeout(entry.timer);
      try { const receipt = operationReceipt(entry.handle, 'ERROR'); finishExecution(entry.handle, { outcome: 'ERROR', artifacts: [receipt], evidenceComplete: true }); } catch { /* running record remains incomplete */ }
      error(entry.id, 'ERROR: browser driver exited before the operation completed.');
    }
    pending.clear();
  });
  return { shutdown };
}
