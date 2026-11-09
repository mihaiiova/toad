#!/usr/bin/env node
/**
 * A stand-in for the Playwright MCP server in Toad's own tests: it speaks
 * MCP over stdio and runs the scripted-run tool's code in a vm context with
 * a tiny fake `page`, exactly as Playwright MCP gives it only `page`.
 *
 *   FAKE_WEB_APP   JSON file: { status?, pages: { "/path": { status?, elements: [...] } } }
 *                  element: { role?, name?, label?, text?, type?, autocomplete?, hidden?, goto? }
 *   FAKE_WEB_MODE  "no-tool" (no scripted-run tool) or "silent" (answer without a result)
 *   FAKE_WEB_LOG   a file each tool call's code is appended to
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const app = process.env.FAKE_WEB_APP ? JSON.parse(readFileSync(process.env.FAKE_WEB_APP, 'utf8')) : { pages: {} };
const mode = process.env.FAKE_WEB_MODE ?? '';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

function fakePage() {
  let url = 'about:blank', elements = [], routeHandler;
  const values = new Map();
  const match = q => elements.filter(q);
  const locator = q => ({
    count: async () => match(q).length,
    isVisible: async () => { const m = match(q); if (m.length > 1) throw new Error('strict mode violation'); return !!m[0] && !m[0].hidden; },
    click: async () => { const m = match(q); if (m.length !== 1) throw new Error('strict mode violation'); if (m[0].goto) await page.goto(new URL(m[0].goto, url).href); },
    fill: async value => { const m = match(q); if (m.length !== 1) throw new Error('strict mode violation'); values.set(m[0], value); },
    innerText: async () => { const m = match(q); if (m.length !== 1) throw new Error('strict mode violation'); return String(m[0].text ?? m[0].name ?? '').replace(/\{(.+?)\}/g, (_, label) => [...values].find(([e]) => e.label === label)?.[1] ?? ''); },
    evaluate: async fn => { const m = match(q); if (m.length !== 1) throw new Error('strict mode violation'); return fn({ getAttribute: n => m[0][n] ?? null }); },
  });
  const page = {
    route: async (_pattern, handler) => { routeHandler = handler; },
    goto: async target => {
      let aborted = false;
      if (routeHandler) await routeHandler({ request: () => ({ isNavigationRequest: () => true, url: () => target }), abort: async () => { aborted = true; }, continue: async () => {} });
      if (aborted) throw new Error('navigation blocked');
      const u = new URL(target);
      if (u.port === '1') throw new Error('net::ERR_CONNECTION_REFUSED');
      const p = app.pages[u.pathname];
      url = u.href; elements = p?.elements ?? [];
      return { status: () => p ? p.status ?? 200 : 404 };
    },
    url: () => url,
    waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))),
    getByRole: (role, { name }) => locator(e => e.role === role && e.name === name),
    getByLabel: label => locator(e => e.label === label),
    getByText: text => locator(e => e.text === text),
  };
  return page;
}

let buffer = '';
const serverRequests = new Set();
process.stdin.setEncoding('utf8').on('data', async chunk => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!m.method && serverRequests.delete(m.id)) {
      send({ id: m.id, result: { content: [{ type: 'text', text: 'server request completed' }] } });
      continue;
    }
    if (m.method === 'initialize' && mode === 'init-hang') continue;
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-web', version: '0' } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [...(mode === 'no-tool' ? [{ name: 'browser_navigate' }] : [{ name: 'browser_navigate' }, { name: 'browser_run_code_unsafe' }]), ...(process.env.FAKE_WEB_DIAGNOSTICS ? ['browser_take_screenshot', 'browser_snapshot', 'browser_console_messages', 'browser_click', 'browser_close'].map(name => ({ name })) : [])] } });
    else if (m.method === 'tools/call') {
      const code = m.params.arguments?.code;
      const secretsFile = process.env.TOAD_PLAYWRIGHT_SECRETS_FILE;
      const secrets = !secretsFile ? null : existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : 'missing';
      if (process.env.FAKE_WEB_LOG) appendFileSync(process.env.FAKE_WEB_LOG, JSON.stringify({ tool: m.params.name, env: { secrets, recording: process.env.TOAD_RECORDING_ENABLED ?? null }, code }) + '\n');
      if (m.params.name === 'browser_take_screenshot') {
        if (mode === 'capture-fail') send({ id: m.id, result: { isError: true } });
        else { const file = resolve(process.env.TOAD_RECEIPTS_DIR, m.params.arguments.filename); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from('fake-png')); send({ id: m.id, result: { content: [] } }); }
        continue;
      }
      if (['browser_snapshot', 'browser_console_messages'].includes(m.params.name)) { send({ id: m.id, result: { content: [{ type: 'text', text: 'diagnostic state' }] } }); continue; }
      if (mode === 'tool-hang' && m.params.name === 'browser_click') continue;
      if (mode === 'server-request' && m.params.name === 'browser_click') {
        serverRequests.add(m.id);
        send({ id: m.id, method: 'sampling/createMessage', params: { messages: [] } });
        continue;
      }
      if (['browser_navigate', 'browser_click', 'browser_close'].includes(m.params.name)) {
        send({ id: m.id, result: { ...(m.params.arguments?.fail ? { isError: true } : {}), content: [{ type: 'text', text: m.params.arguments?.secret ?? 'operation completed' }] } }); continue;
      }
      if (mode === 'hang') continue;
      if (mode === 'silent') { send({ id: m.id, result: { content: [{ type: 'text', text: '### Ran Playwright code\n' + code }] } }); continue; }
      try {
        const context = vm.createContext({ page: fakePage(), URL });
        const result = await vm.runInContext(`(${code})(page)`, context);
        // Playwright MCP echoes the code and adds the result, JSON-encoded.
        send({ id: m.id, result: { content: [{ type: 'text', text: `### Ran Playwright code\n\`\`\`js\nawait (${code})(page);\n\`\`\`\n### Result\n${JSON.stringify(result)}` }] } });
      } catch (error) {
        send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: `### Error\n${error.message}` }] } });
      }
    } else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
process.stdin.on('end', () => { if (process.env.FAKE_WEB_LOG && process.env.FAKE_WEB_DIAGNOSTICS) appendFileSync(process.env.FAKE_WEB_LOG, JSON.stringify({ event: 'close' }) + '\n'); process.exit(0); });
