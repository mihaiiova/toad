#!/usr/bin/env node
/**
 * Revisor MCP: a thin stdio MCP server in front of the Revisor testing bot.
 *
 * It holds no testing logic. Each call builds a test request, runs the bot's
 * declared workflow (`<agent>/run --workflow test`), and maps the workflow's
 * JSON result onto the tool result: the verdict, the report, and the
 * screenshots the bot saved as receipts. The bot lives in ../agent (a Pi
 * Forge project); REVISOR_AGENT_DIR points elsewhere.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT = resolve(process.env.REVISOR_AGENT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../agent'));
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 1024 * 1024;

/** The bot's request: what to test, where, and how. */
function request(target, { what, scenarios = [], secrets = [] }) {
  return [
    ...target,
    `What to test: ${what}`,
    ...(scenarios.length ? ['Scenarios:', ...scenarios.map((s, i) => `${i + 1}. "${s.name}": ${s.steps}; expected: ${s.expected}`)] : []),
    ...(secrets.length ? [`Login secrets, by name: ${secrets.join(', ')}.`] : []),
  ].join('\n');
}

/** Run the workflow; resolves with its JSON result, or a synthesized one if it printed none. */
function runWorkflow(args, signal, onTick) {
  return new Promise(done => {
    const child = spawn(join(AGENT, 'run'), args, { cwd: AGENT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err = (err + d).slice(-4000); });
    // The runner turns SIGTERM into a cancelled run and stops the browser work.
    const cancel = () => child.kill('SIGTERM');
    signal.addEventListener('abort', cancel, { once: true });
    const ticker = setInterval(onTick, 15000);
    child.on('error', error => { err += error.message; });
    child.on('close', code => {
      clearInterval(ticker);
      signal.removeEventListener('abort', cancel);
      const last = out.trim().split('\n').at(-1) ?? '';
      try { done(JSON.parse(last)); }
      catch { done({ status: 'error', answer: '', message: `The workflow printed no result (exit ${code}). ${err.trim().split('\n').slice(-5).join('\n')}` }); }
    });
  });
}

/**
 * The report's verdict: PASS, FAIL or ERROR, or UNKNOWN when it has none. The
 * bot is told to start with `Verdict: X`; headings or bold around the word
 * Verdict, and the value on the next line, are accepted too.
 */
function verdictOf(answer) {
  return /^[#*\s]*Verdict[*:\s]*?(?:\n\s*)*[*\s]*(PASS|FAIL|ERROR)\b/im.exec(answer ?? '')?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

function receiptsIn(dir) {
  try { return readdirSync(dir).sort().map(f => join(dir, f)); } catch { return []; }
}

/** Run one test request through the bot and map its result onto a tool result. */
async function runTest(text, input, extra, { attachImages }) {
  // Absolute, so no tester mistakes it for a folder in the project under test.
  const folder = join(AGENT, 'data/receipts', randomUUID());
  const args = ['--workflow', 'test', '--timeout', `${input.timeout_minutes ?? 15}m`, '--allow-concurrent', '--input', `request=${text}`, '--input', `receipts=${folder}`];
  const token = extra._meta?.progressToken;
  const started = Date.now();
  // Progress keeps clients' request timeouts from expiring during long tests.
  const tick = () => token !== undefined && extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: 'Testing…' } }).catch(() => {});
  const result = await runWorkflow(args, extra.signal, tick);
  const verdict = verdictOf(result.answer);
  const files = receiptsIn(folder);
  const screenshots = files.filter(f => f.endsWith('.png'));
  const images = attachImages ? screenshots
    .filter(path => statSync(path).size <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)
    .map(path => ({ type: 'image', mimeType: 'image/png', data: readFileSync(path).toString('base64') })) : [];
  const failed = result.status !== 'ok';
  const heading = failed
    ? `The test run did not complete: ${result.status}${result.message ? ` (${result.message})` : ''}.`
    : /^\s*Verdict:/i.test(result.answer ?? '') ? '' : `Verdict: ${verdict}`;
  return {
    isError: failed,
    content: [
      { type: 'text', text: [heading, result.answer, files.length ? `Receipts:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n') },
      ...images,
    ],
    structuredContent: { verdict, status: result.status, runId: result.runId ?? null, receipts: folder, files, screenshots },
  };
}

const scenarios = z.array(z.object({
  name: z.string().min(1),
  steps: z.string().min(1).describe('What to do, in order'),
  expected: z.string().min(1).describe('What must be true afterwards'),
})).optional().describe('Concrete scenarios; without them the bot derives scenarios from `what`');
const secrets = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional()
  .describe("Names of login secrets in the bot's .forge/test-secrets.env; values never pass through the call");
const timeout = z.number().int().min(1).max(60).optional().describe('Default 15');
const outputSchema = {
  verdict: z.enum(['PASS', 'FAIL', 'ERROR', 'UNKNOWN']),
  status: z.string().describe('How the run itself ended: ok, error, blocked, timeout, cancelled or configuration_error'),
  runId: z.string().nullable(),
  receipts: z.string().describe("Folder holding this run's receipts"),
  files: z.array(z.string()).describe('Every receipt: screenshots and recorded commands'),
  screenshots: z.array(z.string()),
};

const server = new McpServer({ name: 'revisor', version: '0.2.0' });

server.registerTool('run_web_test', {
  title: 'Run a web test',
  description: 'Tests a web application end to end in a real headless browser and returns the verdict (PASS, FAIL or ERROR), a report per scenario, and screenshots as receipts. Give the URL and what to test; add scenarios with steps and expected outcomes for precise checks. Takes from tens of seconds to several minutes. Use test or staging environments: the bot clicks, types and submits forms.',
  inputSchema: {
    url: z.string().url().describe('Where the application is reachable'),
    what: z.string().min(1).describe('What to test: a goal, a feature or a user flow'),
    scenarios,
    secrets,
    timeout_minutes: timeout,
    screenshots: z.enum(['inline', 'paths']).optional().describe('inline (default): attach up to 8 screenshots as images; paths: only return their file paths'),
  },
  outputSchema,
}, (input, extra) => runTest(request([`Test ${input.url}.`], input), input, extra, { attachImages: input.screenshots !== 'paths' }));

server.registerTool('run_cli_test', {
  title: 'Run a command-line test',
  description: 'Tests a command-line program by running it in a shell, and returns the verdict (PASS, FAIL or ERROR), a report per scenario, and every command as a recorded receipt (command, exit code, output). Give the working folder, how to invoke the program and what to test; add scenarios with steps and expected outcomes for precise checks. Commands run with your user\'s permissions; they write only inside the receipts folder unless a scenario says otherwise.',
  inputSchema: {
    workdir: z.string().min(1).describe('Absolute path of the folder to run the program in, usually the project under test'),
    program: z.string().min(1).describe('How to invoke the program from that folder, for example `node apps/cli/dist/bin.js` or `owlie`'),
    what: z.string().min(1).describe('What to test: a command, a behaviour or a workflow'),
    scenarios,
    secrets,
    timeout_minutes: timeout,
  },
  outputSchema,
}, (input, extra) => runTest(request([`Test the command-line program in the working folder ${input.workdir}.`, `Invoke it as: ${input.program}`], input), input, extra, { attachImages: false }));

await server.connect(new StdioServerTransport());
