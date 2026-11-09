import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { relayWebTransport } from '../../agent/tools/toad-web-transport.mjs';
import { readExecutionRecords } from '../../agent/tools/toad-execution.mjs';
import { createEvaluationFixture, evaluationCases, SENTINEL } from '../evaluation-fixtures.mjs';
import { resolveSecretReferences } from '../project-secrets.mjs';
import { scanEvaluationArtifacts } from '../evaluation.mjs';

// Explicit installed-only seam: never npx, setup, download or model invocation.
const native = process.env.TOAD_TEST_PLAYWRIGHT_MCP_CLI;
const chromium = process.env.TOAD_TEST_CHROMIUM_EXECUTABLE;
const skip = !native || !chromium ? 'set TOAD_TEST_PLAYWRIGHT_MCP_CLI and TOAD_TEST_CHROMIUM_EXECUTABLE to installed pinned MCP/Chromium' : false;

for (const selected of [true, false]) test(`native MCP selected-secret response/artifact contract (selected=${selected})`, { skip, timeout: 30000 }, async t => {
  assert.ok(existsSync(native) && existsSync(chromium), 'explicit native prerequisites must exist');
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../agent/.pi/mcp.json')));
  const pin = config.mcpServers.playwright.args.find(a => a.startsWith('@playwright/mcp@')).split('@').at(-1);
  assert.equal(JSON.parse(readFileSync(join(dirname(native), 'package.json'))).version, pin, 'test uses the shipped native pin');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-native-secret-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await createEvaluationFixture(root, evaluationCases().find(c => c.id === 'web/secret/1'));
  t.after(() => fixture.close());
  const run = join(root, 'run'), receipts = join(run, 'receipts'); mkdirSync(receipts, { recursive: true });
  // Same selected-reference resolver and private dotenv representation as project runs.
  writeFileSync(join(root, '.env'), `EVAL_SENTINEL=${SENTINEL}\n`, { mode: 0o600 });
  const values = resolveSecretReferences(root, selected ? fixture.handoff.credentials : {});
  const secrets = join(root, 'secrets.env');
  writeFileSync(secrets, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  const child = spawn(process.execPath, [native, '--headless', '--isolated', '--no-sandbox', '--executable-path', chromium, '--output-dir', receipts, '--secrets', secrets], { cwd: receipts, env: { PATH: process.env.PATH, HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); // Never print raw native stderr or tool responses on assertion failure.
  const exited = once(child, 'exit');
  const input = new PassThrough(), output = new PassThrough();
  const relay = relayWebTransport(child, { input, output, env: { TOAD_EXECUTION_RUN_DIR: run, TOAD_EXECUTION_SCENARIOS: '["web/secret/1"]' } });
  t.after(async () => { await relay.shutdown(); await exited; });
  const responses = [], pending = new Map(); let id = 0, buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const response = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); responses.push(response);
      pending.get(response.id)?.(response); pending.delete(response.id);
    }
  });
  const rpc = (method, params) => new Promise((done, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`native RPC timeout: ${method}`)); }, 10000);
    pending.set(next, response => { clearTimeout(timer); done(response); });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  });
  let operations = 0;
  const call = async (name, args = {}, isError = false) => {
    if (name !== 'browser_toad_bind_scenario') operations++;
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(!!response.error || !!response.result?.isError, isError, `${name} fixed error classification`);
    return response;
  };
  const text = response => (response.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'toad-offline-secret-regression', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await rpc('tools/list', {});
  await call('browser_toad_bind_scenario', { scenarioName: 'web/secret/1' });
  await call('browser_navigate', { url: fixture.url });
  const find = await call('browser_find', { text: 'Synthetic credential' });
  assert.equal(text(find).includes(SENTINEL), !selected, 'unknown-value negative control is not a masking guarantee');
  await call('browser_click', { target: 'button' });
  assert.ok(text(await call('browser_find', { text: 'Total: $6' })).includes('Total: $6'), 'ordinary invoice evidence remains observable');
  await call('browser_snapshot', { filename: 'saved-snapshot.yml' });
  assert.ok(existsSync(join(receipts, 'saved-snapshot.yml')));
  if (selected) {
    // An authorized alias must still place the actual secret into the input.
    // Verify with a page-local button: the response only says success/failure.
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<label>Authorized credential<input id="authorized" type="password"></label><button onclick="document.querySelector('#ok').textContent=document.querySelector('#authorized').value==='${SENTINEL}'?'authorized-fill-ok':'wrong'">Verify</button><p id="ok"></p>`);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => { server.closeAllConnections(); server.close(); });
    await call('browser_navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    const snapshot = text(await call('browser_snapshot'));
    const ref = /textbox "Authorized credential" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
    assert.ok(ref, 'real native snapshot exposes authorized field reference');
    await call('browser_type', { target: ref, text: 'EVAL_SENTINEL' });
    await call('browser_click', { target: 'button' });
    assert.ok(text(await call('browser_find', { text: 'authorized-fill-ok' })).includes('authorized-fill-ok'), 'authorized fill retains real DOM value');
    // Native errors are also relayed/persisted, not replaced with canned results.
    await call('browser_click', { target: 'nonexistent-control' }, true);
  }
  writeFileSync(join(run, 'session-response.jsonl'), responses.map(m => JSON.stringify(m)).join('\n'));
  const scan = scanEvaluationArtifacts(run);
  assert.equal(scan.complete, true);
  assert.equal(scan.leaked, !selected, 'responses and native textual artifacts use the unchanged bounded scanner');
  if (!selected) assert.ok(scan.leakedFiles >= 2, 'negative control retains actual unsafe outputs only until private fixture cleanup');
  const evidence = readExecutionRecords(run);
  assert.equal(evidence.errors.length, 0);
  assert.equal(evidence.records.length, operations, 'every caller operation has durable evidence');
  assert.ok(evidence.records.every(r => r.scenarioName === 'web/secret/1' && r.evidenceComplete));
  assert.ok(evidence.records.every(r => !r.assertion), 'native operation completion does not fabricate scenario assertions');
});
