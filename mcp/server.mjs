#!/usr/bin/env node
/**
 * Toad MCP: a thin stdio MCP server in front of the Toad testing bot.
 *
 * It holds no testing logic. Each call builds a test request, runs the bot's
 * declared workflow (`<agent>/run --workflow test`), and maps the workflow's
 * JSON result onto the tool result: the verdict, the report, and the
 * screenshots the bot saved as receipts. The bot is a Pi Forge project;
 * agent.mjs finds the prepared copy (TOAD_AGENT_DIR points elsewhere).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, openSync, closeSync, constants, fstatSync } from 'node:fs';
import { resolveSecretReferences } from './project-secrets.mjs';
import { chooseSandbox, isReservedSecretName } from '../agent/tools/toad-sandbox.mjs';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';
import { acquireSlot } from './slots.mjs';
import { overallVerdict, resultsOf, scenarioResults, verdictOf } from './results.mjs';
import { CONFIG_TEMPLATE, readProjectConfig, registerProject, withDefaults } from './projects.mjs';
import { resolveAgent, workflowCommand, workflowEnv, VERSION } from './agent.mjs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.mjs');
/** `toad ui` when that command is this install, else the full node command. */
function viewerCommand() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { if (realpathSync(join(dir, 'toad')) === realpathSync(CLI)) return 'toad ui'; } catch {}
  }
  return `node ${CLI} ui`;
}
const NOT_SET_UP = 'The Toad agent is not set up on this machine. Run `toad setup`, then retry.';
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
function runWorkflow(agent, args, signal, onTick, env = process.env) {
  return new Promise(done => {
    if (signal.aborted) return done({ status: 'cancelled', answer: '', cleanup: 'incomplete', message: 'Cancelled before launch' });
    const launch = workflowCommand(agent, args);
    if (launch.error) return done({ status: 'configuration_error', answer: '', message: launch.error });
    const child = spawn(launch.command, launch.args, { cwd: agent, env: workflowEnv(agent, env), stdio: ['ignore', 'pipe', 'pipe'] });
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
async function runTest(text, input, extra, { attachImages, projectRun, secretValues, cliImage, setup }) {
  const agent = resolveAgent();
  if (!agent) throw new Error(NOT_SET_UP);
  // Project runs write receipts straight into .toad/runs/<id>/receipts; the
  // legacy tools, which have no project, keep the agent's own data/receipts.
  const folder = projectRun ? join(projectRun, 'receipts') : join(agent, 'data', 'receipts', randomUUID());
  const args = ['--workflow', 'test', '--timeout', `${input.timeout_minutes ?? 15}m`, '--allow-concurrent', '--input', `request=${text}`, '--input', `receipts=${folder}`];
  const token = extra._meta?.progressToken;
  const started = Date.now();
  let message = 'Waiting for a free test slot…';
  // Progress keeps clients' request timeouts from expiring during long tests.
  const tick = () => token !== undefined && extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message } }).catch(() => {});
  // Runs from every Toad server on this machine share a small number of slots.
  let lastTick = 0;
  if (projectRun) writeState(projectRun, { state: 'waiting' });
  const release = await acquireSlot({ signal: extra.signal, onWait: () => { if (Date.now() - lastTick >= 15000) { lastTick = Date.now(); tick(); } } });
  if (projectRun) writeState(projectRun, { state: 'running' });
  if (!release) return finish(input, { status: 'cancelled', answer: '', message: 'Cancelled while waiting for a free test slot' }, folder, { attachImages, projectRun });
  message = 'Testing…';
  try { return await launch(); } finally { release(); }

  async function launch() {
    let secretDir;
    const env = { ...process.env, TOAD_RECEIPTS_DIR: folder };
    // Legacy tools must not accidentally inherit another caller's selector.
    delete env.TOAD_PLAYWRIGHT_SECRETS_FILE;
    delete env.TOAD_CLI_SECRETS_FILE;
    // A project's image wins over one set where the server is registered.
    if (cliImage) env.TOAD_CLI_IMAGE = cliImage;
    if (secretValues) {
      // CLI and API tests run in the CLI sandbox and take secrets as environment variables.
      const cli = input.handoff?.kind === 'cli' || input.handoff?.kind === 'api';
      secretDir = mkdtempSync(join(privateDir(join(toadDirs().runtime, 'secrets')), cli ? 'toad-cli-' : 'toad-browser-'));
      const secretFile = join(secretDir, cli ? 'secrets.json' : 'secrets.env');
      try {
        const data = cli ? JSON.stringify(secretValues) : Object.entries(secretValues).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
        writeFileSync(secretFile, data, { flag: 'wx', mode: 0o600 });
      } catch (error) { rmSync(secretDir, { recursive: true, force: true }); throw error; }
      env[cli ? 'TOAD_CLI_SECRETS_FILE' : 'TOAD_PLAYWRIGHT_SECRETS_FILE'] = secretFile;
    }
    let base, result;
    try {
      if (setup?.commands?.length) {
        message = 'Running setup…';
        const prepared = await runSetup(agent, setup, env, folder, extra.signal);
        base = prepared.workspace;
        if (extra.signal.aborted) result = { status: 'cancelled', answer: '', cleanup: 'complete', message: 'Cancelled during setup' };
        else if (prepared.failure) result = prepared.failure;
        else env.TOAD_BASE_SCENARIO = prepared.id;
        message = 'Testing…';
      }
      result ??= await runWorkflow(agent, args, extra.signal, tick, env);
    } finally {
      if (base) rmSync(base, { recursive: true, force: true });
    }
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
    return finish(input, result, folder, { attachImages, projectRun });
  }
}

/** Run one Toad tool command (toad-exec) in the agent folder. */
function toolCommand(agent, args, env, signal) {
  return new Promise(done => {
    const child = spawn(process.execPath, [join(agent, 'tools', 'toad-exec.mjs'), ...args], { cwd: agent, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err += d; });
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', error => { err += error.message; });
    child.on('close', code => { signal?.removeEventListener('abort', cancel); done({ code, out, err }); });
  });
}

/**
 * Run the handoff's setup commands once, in a sandbox workspace made from the
 * working folder. Every scenario then starts from a copy of it. Each command
 * is recorded under receipts/setup/. A failed command ends the run as ERROR
 * before any scenario starts.
 */
async function runSetup(agent, { commands, workdir, names = [] }, env, folder, signal) {
  const setupEnv = { ...env, TOAD_COMMAND_TIMEOUT_S: String(Number(env.TOAD_SETUP_TIMEOUT_S ?? 900)) };
  delete setupEnv.TOAD_BASE_SCENARIO;
  const failure = (why, receipt) => ({
    status: 'setup_failed', cleanup: 'complete', message: '',
    answer: ['Verdict: ERROR', 'Results:', ...(names.length ? names : ['Setup']).map(name => `- ERROR | ${name}`), '',
      `Setup failed, so no scenario ran: ${why}`, ...(receipt ? [`Receipt: ${receipt}`] : [])].join('\n'),
  });
  const prepared = await toolCommand(agent, ['prepare', workdir], setupEnv, signal);
  const id = /Scenario ID: (\S+)/.exec(prepared.out)?.[1], workspace = /Workspace: (.+)/.exec(prepared.out)?.[1]?.trim();
  if (prepared.code !== 0 || !id) return { failure: failure(`the sandbox could not be prepared (${(prepared.err || prepared.out).trim().split('\n').at(-1)})`) };
  for (const [i, command] of commands.entries()) {
    const name = `${String(i + 1).padStart(2, '0')}-setup`;
    const run = await toolCommand(agent, ['run', join(folder, 'setup'), name, id, command], setupEnv, signal);
    const receipt = join(folder, 'setup', `${name}.txt`);
    const outcome = /^(exit \S+|timed out after \S+|infrastructure error[^;]*?) in /m.exec(run.out)?.[1] ?? `exit ${run.code}`;
    if (run.code !== 0 || outcome !== 'exit 0') return { id, workspace, failure: failure(`\`${command}\` ended with ${outcome}.`, receipt) };
  }
  return { id, workspace };
}

/** Map a workflow result, and the receipts it left, onto a tool result. */
/**
 * A run's progress, for the viewer: waiting for a slot, running, or finished.
 * The pid lets the viewer tell a live run from one whose server died.
 */
function writeState(run, fields) {
  let previous = {};
  try { previous = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8')); } catch {}
  const now = new Date().toISOString();
  const state = { started: previous.started ?? now, pid: process.pid, ...previous, ...fields, updated: now };
  try { writeFileSync(join(run, 'state.json'), JSON.stringify(state) + '\n', { mode: 0o600 }); } catch {}
}

function finish(input, result, folder, { attachImages, projectRun }) {
  const scenarios = scenarioResults(input.handoff?.request?.scenarios ?? input.scenarios, resultsOf(result.answer));
  const verdict = overallVerdict(verdictOf(result.answer), scenarios);
  if (projectRun) writeState(projectRun, { state: 'finished', finished: new Date().toISOString(), verdict, status: result.status, scenarios });
  // Regular files only: agent-created symlinks are never followed.
  const files = receiptsIn(folder);
  // The agent's report normally starts with its own verdict line; when it
  // does not, or its verdict contradicts a scenario's result, Toad's comes first.
  const reported = verdictOf(result.answer);
  const ownVerdict = /^\s*Verdict:/i.test(result.answer ?? '') && reported === verdict;
  const corrected = reported !== 'UNKNOWN' && reported !== verdict ? `(The report said ${reported}; a scenario's result makes the run ${verdict}.)` : '';
  if (projectRun) {
    writeFileSync(join(projectRun, 'reports', 'report.md'), [
      `# Toad run`, `Status: ${result.status}`, ...(ownVerdict ? [] : [`Verdict: ${verdict}`]), corrected,
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
    : ownVerdict ? '' : [`Verdict: ${verdict}`, corrected].filter(Boolean).join('\n');
  return {
    isError: failed,
    content: [
      { type: 'text', text: [heading, result.answer, files.length ? `Receipts:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n') },
      ...images,
    ],
    structuredContent: { verdict, status: result.status, runId: result.runId ?? null, scenarios, receipts: folder, files, screenshots },
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
  scenarios: z.array(z.object({ name: z.string(), result: z.enum(['PASS', 'FAIL', 'ERROR']), missing: z.boolean().optional() }))
    .describe("Each scenario's result, by the name the handoff gave it; a scenario the report left out is ERROR with missing: true"),
  receipts: z.string().describe("Folder holding this run's receipts"),
  files: z.array(z.string()).describe('Every receipt: screenshots and recorded commands'),
  screenshots: z.array(z.string()),
};

const server = new McpServer({ name: 'toad', version: VERSION }, {
  instructions: 'Before using Toad to test a project, call get_toad_guide for the current testing and credential-safety instructions. The guide is also available as the toad://guide resource. Never put secret values in a handoff or chat.',
});

// Serve the same guide as the distributable skill; avoid a second copy that
// could drift from the instructions installed by coding agents.
const guidePath = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/toad-mcp/SKILL.md');
const guide = () => readFileSync(guidePath, 'utf8');
server.registerResource('toad-guide', 'toad://guide', {
  title: 'Toad MCP testing guide',
  description: 'Instructions for coding agents using Toad, including project setup and credential safety.',
  mimeType: 'text/markdown',
}, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide() }] }));
server.registerTool('get_toad_guide', {
  title: 'Get Toad testing instructions',
  description: 'Read the Toad coding-agent skill before preparing a test or project handoff. Includes setup, credential safety, sandbox limitations, and result interpretation.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, () => ({ content: [{ type: 'text', text: guide() }] }));

function projectFolder(path) {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('project_path must be an absolute path without traversal');
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
  title: 'Set up Toad in a project',
  description: 'Initialize .toad in an existing project. Call get_toad_guide for testing and credential guidance. Keep all handoffs, receipts and reports in .toad/runs. Put secret values only in .toad/.env and reference them by name in handoffs. Writes toad.yaml for project defaults (app URL, CLI program, timeout) and adds the project to the machine-wide run viewer. Existing files are never overwritten.',
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
  createIfMissing(join(folder, 'toad.yaml'), CONFIG_TEMPLATE, 0o644);
  readProjectConfig(folder);
  registerProject(dirname(folder));
  return { content: [{ type: 'text', text: `Toad project initialized at ${folder}. Store secrets in .env, never in handoffs. Put defaults such as the app URL or CLI program in toad.yaml. Runs are stored in runs/<run-id>/. View every project's runs in a browser with: ${viewerCommand()}. Handoffs reference credentials as {env: NAME}; trusted runs only.` }] };
});

const valueOrEnv = z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict();
const handoffSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['web', 'cli', 'api']),
  title: z.string().min(1).max(120).optional().describe('A short name for the run, shown in the run viewer'),
  target: z.object({
    url: z.string().url().optional().describe('web: the app; api: the API base URL'),
    workdir: z.string().optional().describe('cli: where the program runs; api: the folder with the OpenAPI description and fixtures, default the project'),
    program: z.string().optional(),
    spec: z.string().min(1).optional().describe('api: the OpenAPI description, relative to workdir'),
    image: z.string().min(1).optional(),
    setup: z.array(z.string().min(1)).max(20).optional().describe('cli/api: shell commands Toad runs once in the sandbox before any scenario, e.g. installing a pinned tool; every scenario starts from the result'),
  }).strict().optional()
    .describe('Omitted fields come from the project\'s .toad/toad.yaml'),
  request: z.object({ goal: z.string().min(1), scenarios }).strict(),
  credentials: z.record(z.string(), valueOrEnv).optional(),
  limitations: z.array(z.string()).optional(),
  allow_installs: z.boolean().optional().describe('cli/api: let testers install a missing prerequisite inside the sandbox and retry; default false (they report it)'),
}).strict();

const LOOPBACK = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;
/**
 * What the lead is told about an API under test. Requests run in the CLI
 * sandbox; in a container, the host's loopback is host.docker.internal.
 */
function apiTarget({ url, workdir, spec }) {
  const lines = [`Test the HTTP API at ${url}.`];
  let container = false;
  try { container = chooseSandbox().sandbox === 'container'; } catch {}
  if (container && LOOPBACK.test(url)) {
    lines.push(`Requests run in a container, so use ${url.replace(LOOPBACK, '$1host.docker.internal')} instead. The API must listen on all interfaces (0.0.0.0), not only on 127.0.0.1.`);
  }
  lines.push(`Working folder, copied into the sandbox, with the API's description and test fixtures: ${workdir}.`);
  if (spec) lines.push(`The OpenAPI description is ${spec} in that folder; check responses against it.`);
  return lines;
}

server.registerTool('run_project_test', {
  title: 'Run a project test from a handoff',
  description: 'Run a project handoff: kind web (a site in a real browser), cli (a command-line program in a sandbox) or api (an HTTP API, with requests recorded as receipts). First call get_toad_guide for setup and safety guidance. Target fields and the timeout default to the project\'s .toad/toad.yaml. Credentials must be references {env: NAME}, never values. Project runs use a per-run secrets file. Trusted runs only: agents, tools and same-user processes can access credentials; artifacts may expose them.',
  inputSchema: { project_path: z.string().min(1), handoff: handoffSchema, timeout_minutes: timeout, screenshots: z.enum(['inline', 'paths']).optional() },
  outputSchema,
}, async (input, extra) => {
  const folder = projectFolder(input.project_path);
  if (!lstatSync(folder).isDirectory() || !lstatSync(join(folder, 'runs')).isDirectory()) throw new Error('Run setup_project first');
  checkIgnore(join(folder, '.gitignore'));
  const config = readProjectConfig(folder);
  const h = withDefaults(input.handoff, config, dirname(folder));
  input = { ...input, timeout_minutes: input.timeout_minutes ?? config.timeout_minutes };
  registerProject(dirname(folder));
  if (h.kind === 'web' && !h.target.url) throw new Error('A web handoff requires target.url, in the handoff or as web.url in .toad/toad.yaml');
  if (h.kind === 'cli' && (!h.target.workdir || !h.target.program)) throw new Error('A CLI handoff requires target.workdir and target.program, in the handoff or under cli: in .toad/toad.yaml');
  if (h.kind === 'api' && !h.target.url) throw new Error('An API handoff requires target.url, in the handoff or as api.url in .toad/toad.yaml');
  if (h.kind !== 'web' && Object.values(h.credentials ?? {}).some(ref => isReservedSecretName(ref.env))) throw new Error(`${h.kind.toUpperCase()} credentials contain a reserved environment name`);
  if (h.kind === 'web' && (h.target.setup?.length || h.allow_installs)) throw new Error('setup and allow_installs apply to cli and api handoffs; a web test runs in a browser');
  const secretValues = resolveSecretReferences(folder, h.credentials);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const run = join(folder, 'runs', id);
  ensureDirectory(run);
  ensureDirectory(join(run, 'receipts'));
  ensureDirectory(join(run, 'reports'));
  // JSON is a YAML 1.2 subset and avoids an additional YAML parser dependency.
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(h, null, 2) + '\n', { mode: 0o600 });
  // Recorded at once, so a run that never starts is not shown as running.
  writeState(run, { state: 'starting' });
  try {
    return await projectRun(input, extra, h, run, secretValues);
  } catch (error) {
    writeState(run, { state: 'failed', finished: new Date().toISOString(), error: error.message });
    throw error;
  }
});

async function projectRun(input, extra, h, run, secretValues) {
  const target = h.kind === 'web' ? [`Test ${h.target.url}.`]
    : h.kind === 'api' ? apiTarget(h.target)
      : [`Test the command-line program in the working folder ${h.target.workdir}.`, `Invoke it as: ${h.target.program}`];
  const text = [request(target, { what: h.request.goal, scenarios: h.request.scenarios }),
    ...(h.credentials ? [`Credential roles and secret names: ${JSON.stringify(h.credentials)}. ${h.kind === 'web' ? 'Use each env name as the Playwright secret name' : 'Use each env name as a shell environment variable'}; never print its value.`] : []),
    ...(h.target.setup?.length ? [`Setup already ran in the sandbox, so every prepared scenario starts with its result: ${h.target.setup.map(c => `\`${c}\``).join('; ')}.`] : []),
    ...(h.kind === 'web' ? [] : [h.allow_installs
      ? 'Installing prerequisites is allowed: a tester may install a missing program, package or module inside the scenario workspace or $HOME, record the install, and retry the step.'
      : 'Installing prerequisites is not allowed: report a missing program, package or module as a missing prerequisite (ERROR) instead of installing it.']),
    ...(h.limitations?.length ? ['Limitations:', ...h.limitations.map(item => `- ${item}`)] : [])].join('\n');
  const setup = h.target.setup?.length ? { commands: h.target.setup, workdir: h.target.workdir, names: (h.request.scenarios ?? []).map(s => s.name) } : undefined;
  const result = await runTest(text, input, extra, { attachImages: h.kind === 'web' && input.screenshots !== 'paths', projectRun: run, secretValues, cliImage: h.kind === 'web' ? undefined : h.target.image, setup });
  result.content[0].text += `\n\nHandoff: ${join(run, 'handoff.yaml')}\nReport: ${join(run, 'reports', 'report.md')}`;
  return result;
}

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
