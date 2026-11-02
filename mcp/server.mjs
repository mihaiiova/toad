#!/usr/bin/env node
/**
 * TOaD MCP: a thin stdio MCP server in front of the TOaD testing bot.
 *
 * It holds no testing logic. Each call builds a test request, runs the bot's
 * declared workflow (`<agent>/run --workflow test`), and maps the workflow's
 * JSON result onto the tool result: the verdict, the report, and the
 * screenshots the bot saved as receipts. The bot lives in ../agent (a Pi
 * Forge project); TOAD_AGENT_DIR points elsewhere.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, realpathSync, openSync, closeSync, constants, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveSecretReferences } from './project-secrets.mjs';
import { isReservedSecretName } from '../agent/tools/toad-sandbox.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT = resolve(process.env.TOAD_AGENT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../agent'));
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
function runWorkflow(args, signal, onTick, env = process.env) {
  return new Promise(done => {
    if (signal.aborted) return done({ status: 'cancelled', answer: '', cleanup: 'incomplete', message: 'Cancelled before launch' });
    const child = spawn(join(AGENT, 'run'), args, { cwd: AGENT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      catch { done({ status: 'error', answer: '', cleanup: 'incomplete', message: `The workflow printed no result (exit ${code}). ${err.trim().split('\n').slice(-5).join('\n')}` }); }
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
  const files = [];
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  try { visit(dir); } catch { return files; }
  return files;
}

/** Run one test request through the bot and map its result onto a tool result. */
async function runTest(text, input, extra, { attachImages, projectRun, secretValues }) {
  // The current agent only permits receipts under its own data/receipts.
  const folder = join(AGENT, 'data/receipts', randomUUID());
  const args = ['--workflow', 'test', '--timeout', `${input.timeout_minutes ?? 15}m`, '--allow-concurrent', '--input', `request=${text}`, '--input', `receipts=${folder}`];
  const token = extra._meta?.progressToken;
  const started = Date.now();
  // Progress keeps clients' request timeouts from expiring during long tests.
  const tick = () => token !== undefined && extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: 'Testing…' } }).catch(() => {});
  let secretDir;
  const env = { ...process.env };
  // Legacy tools must not accidentally inherit another caller's selector.
  delete env.TOAD_PLAYWRIGHT_SECRETS_FILE;
  delete env.TOAD_CLI_SECRETS_FILE;
  if (secretValues) {
    const cli = input.handoff?.kind === 'cli';
    secretDir = mkdtempSync(join(tmpdir(), cli ? 'toad-cli-' : 'toad-browser-'));
    const secretFile = join(secretDir, cli ? 'secrets.json' : 'secrets.env');
    try {
      const data = cli ? JSON.stringify(secretValues) : Object.entries(secretValues).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
      writeFileSync(secretFile, data, { flag: 'wx', mode: 0o600 });
    } catch (error) { rmSync(secretDir, { recursive: true, force: true }); throw error; }
    env[cli ? 'TOAD_CLI_SECRETS_FILE' : 'TOAD_PLAYWRIGHT_SECRETS_FILE'] = secretFile;
  }
  const result = await runWorkflow(args, extra.signal, tick, env);
  const redact = value => typeof value === 'string' ? Object.values(secretValues ?? {}).filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) : value;
  result.answer = redact(result.answer);
  result.message = redact(result.message);
  if (secretDir) {
    if (result.cleanup === 'incomplete') result.message = [result.message, `Cleanup incomplete; sensitive secrets retained at ${secretDir}`].filter(Boolean).join('. ');
    else {
      try { rmSync(secretDir, { recursive: true, force: true }); }
      catch { result.message = [result.message, `Cleanup incomplete; sensitive secrets retained at ${secretDir}`].filter(Boolean).join('. '); result.cleanup = 'incomplete'; }
    }
  }
  const verdict = verdictOf(result.answer);
  let files = receiptsIn(folder);
  if (projectRun) {
    // Copy only regular files, never follow agent-created symlinks.
    files = files.filter(f => lstatSync(f).isFile()).map(f => {
      const destination = join(projectRun, 'receipts', f.slice(folder.length + 1));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(f, destination);
      return destination;
    });
    writeFileSync(join(projectRun, 'reports', 'report.md'), [
      `# TOaD run`, `Status: ${result.status}`, `Verdict: ${verdict}`,
      result.answer ?? '', result.message ?? '',
    ].filter(Boolean).join('\n\n') + '\n', { mode: 0o600 });
  }
  const screenshots = files.filter(f => f.endsWith('.png'));
  const images = attachImages ? screenshots
    .filter(path => statSync(path).size <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)
    .map(path => ({ type: 'image', mimeType: 'image/png', data: readFileSync(path).toString('base64') })) : [];
  const failed = result.status !== 'ok' || result.cleanup === 'incomplete';
  const heading = failed
    ? `The test run did not complete: ${result.status}${result.message ? ` (${result.message})` : ''}.`
    : /^\s*Verdict:/i.test(result.answer ?? '') ? '' : `Verdict: ${verdict}`;
  return {
    isError: failed,
    content: [
      { type: 'text', text: [heading, result.answer, files.length ? `Receipts:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n') },
      ...images,
    ],
    structuredContent: { verdict, status: result.status, runId: result.runId ?? null, receipts: projectRun ? join(projectRun, 'receipts') : folder, files, screenshots },
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

const server = new McpServer({ name: 'toad', version: '0.2.0' }, {
  instructions: 'Before using TOaD to test a project, call get_toad_guide for the current testing and credential-safety instructions. The guide is also available as the toad://guide resource. Never put secret values in a handoff or chat.',
});

// Serve the same guide as the distributable skill; avoid a second copy that
// could drift from the instructions installed by coding agents.
const guidePath = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/toad-mcp/SKILL.md');
const guide = () => readFileSync(guidePath, 'utf8');
server.registerResource('toad-guide', 'toad://guide', {
  title: 'TOaD MCP testing guide',
  description: 'Instructions for coding agents using TOaD, including project setup and credential safety.',
  mimeType: 'text/markdown',
}, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide() }] }));
server.registerTool('get_toad_guide', {
  title: 'Get TOaD testing instructions',
  description: 'Read the TOaD coding-agent skill before preparing a test or project handoff. Includes setup, credential safety, sandbox limitations, and result interpretation.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, () => ({ content: [{ type: 'text', text: guide() }] }));

function projectFolder(path) {
  if (!path.startsWith('/') || path.split('/').includes('..')) throw new Error('project_path must be an absolute path without traversal');
  const project = resolve(path);
  if (realpathSync(project) !== project || !statSync(project).isDirectory()) throw new Error('project_path must be an existing canonical directory without symlinks');
  return join(project, '.toad');
}

function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Expected a regular file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function checkIgnore(path) {
  const rules = readRegular(path).split(/\r?\n/).map(line => line.trim());
  if (!rules.includes('.env') || !rules.includes('runs/') || rules.some(line => line.startsWith('!'))) {
    throw new Error('Ensure .toad/.gitignore contains .env and runs/ and no negation rules');
  }
}

function ensureDirectory(path) {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

function createIfMissing(path, text, mode = 0o600) {
  try { writeFileSync(path, text, { flag: 'wx', mode }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

server.registerTool('setup_project', {
  title: 'Set up TOaD in a project',
  description: 'Initialize .toad in an existing project. Call get_toad_guide for testing and credential guidance. Keep all handoffs, receipts and reports in .toad/runs. Put secret values only in .toad/.env and reference them by name in handoffs. Writes history.mjs, a localhost web viewer for past runs. Existing files are never overwritten.',
  inputSchema: { project_path: z.string().min(1).describe('Absolute path to the project directory') },
}, ({ project_path }) => {
  const folder = projectFolder(project_path);
  ensureDirectory(folder);
  ensureDirectory(join(folder, 'runs'));
  const ignore = join(folder, '.gitignore');
  // Do not silently claim existing ignore rules protect secrets.
  createIfMissing(ignore, '.env\nruns/\n', 0o644);
  checkIgnore(ignore);
  createIfMissing(join(folder, '.env'), '', 0o600);
  if (!lstatSync(join(folder, '.env')).isFile()) throw new Error('Project .env must be a regular file, not a symlink');
  createIfMissing(join(folder, '.env.example'), '# Add secret variable names and descriptions here; never add values.\n', 0o644);
  createIfMissing(join(folder, 'history.mjs'), readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'history.mjs'), 'utf8'), 0o755);
  return { content: [{ type: 'text', text: `TOaD project initialized at ${folder}. Store secrets in .env, never in handoffs. Runs are stored in runs/<run-id>/. View results in a browser with: node ${join(folder, 'history.mjs')}. Handoffs reference credentials as {env: NAME}; trusted runs only.` }] };
});

const valueOrEnv = z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict();
const handoffSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['web', 'cli']),
  target: z.object({ url: z.string().url().optional(), workdir: z.string().optional(), program: z.string().optional() }).strict(),
  request: z.object({ goal: z.string().min(1), scenarios }).strict(),
  credentials: z.record(z.string(), valueOrEnv).optional(),
  limitations: z.array(z.string()).optional(),
}).strict();

server.registerTool('run_project_test', {
  title: 'Run a project test from a handoff',
  description: 'Run a project handoff. First call get_toad_guide for setup and safety guidance. Credentials must be references {env: NAME}, never values. Project runs use a per-run secrets file. Trusted runs only: agents, tools and same-user processes can access credentials; artifacts may expose them.',
  inputSchema: { project_path: z.string().min(1), handoff: handoffSchema, timeout_minutes: timeout, screenshots: z.enum(['inline', 'paths']).optional() },
  outputSchema,
}, async (input, extra) => {
  const folder = projectFolder(input.project_path);
  if (!lstatSync(folder).isDirectory() || !lstatSync(join(folder, 'runs')).isDirectory()) throw new Error('Run setup_project first');
  checkIgnore(join(folder, '.gitignore'));
  const h = input.handoff;
  if (h.kind === 'web' && !h.target.url) throw new Error('A web handoff requires target.url');
  if (h.kind === 'cli' && (!h.target.workdir || !h.target.program)) throw new Error('A CLI handoff requires target.workdir and target.program');
  if (h.kind === 'cli' && Object.values(h.credentials ?? {}).some(ref => isReservedSecretName(ref.env))) throw new Error('CLI credentials contain a reserved environment name');
  const secretValues = resolveSecretReferences(folder, h.credentials);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const run = join(folder, 'runs', id);
  ensureDirectory(run);
  ensureDirectory(join(run, 'receipts'));
  ensureDirectory(join(run, 'reports'));
  // JSON is a YAML 1.2 subset and avoids an additional YAML parser dependency.
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(h, null, 2) + '\n', { mode: 0o600 });
  const target = h.kind === 'web' ? [`Test ${h.target.url}.`] : [`Test the command-line program in the working folder ${h.target.workdir}.`, `Invoke it as: ${h.target.program}`];
  const text = [request(target, { what: h.request.goal, scenarios: h.request.scenarios }),
    ...(h.credentials ? [`Credential roles and secret names: ${JSON.stringify(h.credentials)}. ${h.kind === 'web' ? 'Use each env name as the Playwright secret name' : 'Use each env name as a shell environment variable'}; never print its value.`] : []),
    ...(h.limitations?.length ? ['Limitations:', ...h.limitations.map(item => `- ${item}`)] : [])].join('\n');
  const result = await runTest(text, input, extra, { attachImages: h.kind === 'web' && input.screenshots !== 'paths', projectRun: run, secretValues });
  result.content[0].text += `\n\nHandoff: ${join(run, 'handoff.yaml')}\nReport: ${join(run, 'reports', 'report.md')}`;
  return result;
});

server.registerTool('run_web_test', {
  title: 'Run a web test',
  description: 'Call get_toad_guide before testing; this legacy tool uses the shared agent secret store. Tests a web application end to end in a real headless browser and returns the verdict (PASS, FAIL or ERROR), a report per scenario, and screenshots as receipts. Give the URL and what to test; add scenarios with steps and expected outcomes for precise checks. Takes from tens of seconds to several minutes. Use test or staging environments: the bot clicks, types and submits forms.',
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
  description: 'Call get_toad_guide before testing; this legacy tool uses the shared agent secret store. Tests a command-line program by running it in a shell, and returns the verdict (PASS, FAIL or ERROR), a report per scenario, and every command as a recorded receipt (command, exit code, output). Give the working folder, how to invoke the program and what to test; add scenarios with steps and expected outcomes for precise checks. Commands run with your user\'s permissions; they write only inside the receipts folder unless a scenario says otherwise.',
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
