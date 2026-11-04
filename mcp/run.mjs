/**
 * Running a test: the one path the MCP tools and `toad run` share.
 *
 * A run builds the bot's request, waits for a machine-wide slot, runs any
 * setup commands, runs the bot's test workflow (`pi -p "/skill:test …"` in
 * JSON mode) and maps the run onto a result: the verdict, each
 * scenario's result, the report and the receipts. Project runs keep
 * everything under .toad/runs/<id>/, where `toad ui` shows them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveSecretReferences } from './project-secrets.mjs';
import { chooseSandbox, isReservedSecretName } from '../agent/tools/toad-sandbox.mjs';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';
import { acquireSlot } from './slots.mjs';
import { overallVerdict, resultsOf, scenarioResults, verdictOf } from './results.mjs';
import { checkIgnore, ensureDirectory, projectFolder, readProjectConfig, registerProject, withDefaults } from './projects.mjs';
import { agentFor, resolveAgent, resolveModels, workflowCommand, workflowEnv } from './agent.mjs';

export const NOT_SET_UP = 'The Toad agent is not set up on this machine. Run `toad setup`, then retry.';
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 1024 * 1024;

/** The bot's request: what to test, where, and how. */
export function request(target, { what, scenarios = [], secrets = [] }) {
  return [
    ...target,
    `What to test: ${what}`,
    ...(scenarios.length ? ['Scenarios:', ...scenarios.map((s, i) => `${i + 1}. "${s.name}": ${s.steps}; expected: ${s.expected}`)] : []),
    ...(secrets.length ? [`Login secrets, by name: ${secrets.join(', ')}.`] : []),
  ].join('\n');
}

/** The last assistant message of a JSON-mode run, from its agent_end events. */
export function finalMessage(lines) {
  let last = null;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'agent_end') last = (event.messages ?? []).filter(m => m?.role === 'assistant').at(-1) ?? last;
  }
  return last;
}

/**
 * Every process below `pid`, with its process group, as `ps` lists them
 * (Linux and macOS). pi-subagents starts background testers detached, in
 * their own process groups, so signalling Pi's group alone would leave them
 * and their browsers running.
 */
export function processTree(pid) {
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (listing.status !== 0) return [];
  const children = new Map();
  for (const line of listing.stdout.trim().split('\n')) {
    const [child, parent, pgid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ pid: child, pgid });
  }
  const tree = [];
  for (const queue = [pid]; queue.length;) for (const child of children.get(queue.shift()) ?? []) { tree.push(child); queue.push(child.pid); }
  return tree;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/**
 * Run the test workflow in Pi; resolves with { status, answer, message?, cleanup? }.
 * Pi starts in its own process group. A timeout or cancellation records the
 * processes below it, signals every process group among them (SIGTERM, then
 * SIGKILL after 5 s) and reports cleanup as incomplete when one survives; a
 * process that left the tree before the stop is not seen. Pi's exit code
 * reports the run, not the test: the verdict is in the answer.
 */
function runWorkflow(agent, run, signal, onTick, env, piArgs) {
  return new Promise(done => {
    if (signal.aborted) return done({ status: 'cancelled', answer: '', cleanup: 'complete', message: 'Cancelled before launch' });
    const launch = workflowCommand(agent, run, piArgs, env);
    if (launch.error) return done({ status: 'configuration_error', answer: '', message: launch.error });
    const posix = process.platform !== 'win32';
    const child = spawn(launch.command, launch.args, { cwd: agent, env: workflowEnv(agent, env), stdio: ['ignore', 'pipe', 'pipe'], detached: posix });
    let out = '', err = '', stopped = null, tree = [];
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err = (err + d).slice(-4000); });
    const signalAll = sig => {
      if (!posix) { try { child.kill(sig); } catch {} return; }
      for (const group of new Set([child.pid, ...tree.map(p => p.pgid)])) { try { process.kill(-group, sig); } catch {} }
      for (const { pid } of tree) { try { process.kill(pid, sig); } catch {} }
    };
    // Pi itself is reaped once it closes; what can survive is below it.
    const survivors = () => tree.map(p => p.pid).filter(alive);
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      if (posix && child.pid) tree = processTree(child.pid);
      signalAll('SIGTERM');
      setTimeout(() => signalAll('SIGKILL'), 5000).unref();
    };
    const cancel = () => stop('cancelled');
    signal.addEventListener('abort', cancel, { once: true });
    const minutes = run.timeoutMinutes ?? 15;
    // TOAD_TEST_TIMEOUT_MS shortens the limit for Toad's own tests only.
    const timer = setTimeout(() => stop('timeout'), Number(env.TOAD_TEST_TIMEOUT_MS) || minutes * 60000);
    const ticker = setInterval(onTick, 15000);
    child.on('error', error => { err += error.message; });
    child.on('close', async code => {
      clearTimeout(timer); clearInterval(ticker);
      signal.removeEventListener('abort', cancel);
      const message = finalMessage(out.split('\n'));
      const answer = (message?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('');
      const tail = err.trim().split('\n').slice(-5).join('\n');
      if (stopped) {
        // Wait for the SIGKILL before deciding whether anything survived.
        for (let i = 0; i < 60 && survivors().length; i++) await new Promise(r => setTimeout(r, 100));
        const cleanup = survivors().length ? 'incomplete' : 'complete';
        if (stopped === 'timeout') return done({ status: 'timeout', answer, cleanup, message: `No result within ${minutes} minutes` });
        return done({ status: 'cancelled', answer, cleanup });
      }
      if (code !== 0) return done({ status: 'error', answer, message: `Pi exited with ${code}. ${tail}`.trim() });
      if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return done({ status: 'error', answer, message: message.errorMessage ?? `The run ended: ${message.stopReason}` });
      if (!answer) return done({ status: 'error', answer, message: `The run returned no answer. ${tail}`.trim() });
      done({ status: 'ok', answer });
    });
  });
}

function filesIn(dir, keep = () => true) {
  const files = [];
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && keep(path)) files.push(path);
    }
  }
  try { visit(dir); } catch { return files; }
  return files;
}

/**
 * What a run has spent so far, in US dollars: the cost Pi records on each
 * model reply, summed over the lead's session and every tester's. Pi prices
 * replies from its model catalog; a model without prices counts as zero.
 * The copies pi-subagents keeps under subagent-artifacts/ are not counted twice.
 */
export function sessionCost(dir) {
  let total = 0;
  for (const file of filesIn(dir, path => path.endsWith('.jsonl') && !path.split(/[\\/]/).includes('subagent-artifacts'))) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
        const cost = entry.message.usage?.cost;
        const value = typeof cost === 'number' ? cost : cost?.total;
        if (Number.isFinite(value) && value > 0) total += value;
      } catch {}
    }
  }
  return total;
}

/**
 * Run one test request through the bot and map its result onto a tool result.
 *
 * `ctx.signal` cancels the run; `ctx.progress(message, seconds)` is called
 * while it waits and runs. Options: `agent` (default: the set-up agent),
 * `env` (default: this process's), `maxCost` (USD; the run stops and counts
 * as ERROR once Pi has recorded more), `sessions` (where Pi keeps this run's
 * sessions; needed for `maxCost` and the cost in the result).
 */
export async function runTest(text, input, ctx, { attachImages, projectRun, secretValues, cliImage, setup, agent = resolveAgent(), env: baseEnv = process.env, maxCost, sessions }) {
  if (!agent) throw new Error(NOT_SET_UP);
  // Project runs write receipts straight into .toad/runs/<id>/receipts; the
  // legacy tools, which have no project, keep the agent's own data/receipts.
  const folder = projectRun ? join(projectRun, 'receipts') : join(agent, 'data', 'receipts', randomUUID());
  const run = { request: text, receipts: folder, timeoutMinutes: input.timeout_minutes ?? 15 };
  const started = Date.now();
  let message = 'Waiting for a free test slot…';
  // Progress keeps clients' request timeouts from expiring during long tests.
  const tick = () => ctx.progress?.(message, Math.round((Date.now() - started) / 1000));
  // Runs from every Toad server on this machine share a small number of slots.
  let lastTick = 0;
  if (projectRun) writeState(projectRun, { state: 'waiting' });
  const release = await acquireSlot({ signal: ctx.signal, onWait: () => { if (Date.now() - lastTick >= 15000) { lastTick = Date.now(); tick(); } } });
  if (projectRun) writeState(projectRun, { state: 'running', timeoutMinutes: run.timeoutMinutes });
  if (!release) return finish(input, { status: 'cancelled', answer: '', message: 'Cancelled while waiting for a free test slot' }, folder, { attachImages, projectRun });
  message = 'Testing…';
  try { return await launch(); } finally { release(); }

  async function launch() {
    let secretDir;
    const env = { ...baseEnv, TOAD_RECEIPTS_DIR: folder };
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
    // A spending limit stops the workflow like a cancellation, then names the cause.
    const budget = new AbortController();
    const stop = () => budget.abort();
    ctx.signal.addEventListener('abort', stop, { once: true });
    let overBudget = false, spent = 0;
    const meter = sessions && setInterval(() => {
      spent = sessionCost(sessions);
      if (maxCost !== undefined && spent > maxCost && !overBudget) { overBudget = true; message = 'Stopping: over the spending limit…'; budget.abort(); }
    }, 2000);
    let base, result;
    try {
      if (setup?.commands?.length) {
        message = 'Running setup…';
        const prepared = await runSetup(agent, setup, env, folder, budget.signal);
        base = prepared.workspace;
        if (budget.signal.aborted) result = { status: 'cancelled', answer: '', cleanup: 'complete', message: 'Cancelled during setup' };
        else if (prepared.failure) result = prepared.failure;
        else env.TOAD_BASE_SCENARIO = prepared.id;
        message = 'Testing…';
      }
      result ??= await runWorkflow(agent, run, budget.signal, tick, env, sessions ? ['--session-dir', sessions] : []);
    } finally {
      if (meter) clearInterval(meter);
      ctx.signal.removeEventListener('abort', stop);
      if (base) rmSync(base, { recursive: true, force: true });
    }
    if (sessions) spent = sessionCost(sessions);
    if (overBudget || (maxCost !== undefined && spent > maxCost && result.status === 'ok')) {
      result = { ...result, status: 'cost_limit', message: `Stopped: Pi recorded $${spent.toFixed(4)}, over the $${maxCost} limit` };
    }
    if (sessions) result.cost = spent;
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

/**
 * A run's progress, for the viewer: waiting for a slot, running, or finished.
 * The pid lets the viewer tell a live run from one whose server died.
 */
export function writeState(run, fields) {
  let previous = {};
  try { previous = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8')); } catch {}
  const now = new Date().toISOString();
  const state = { started: previous.started ?? now, pid: process.pid, ...previous, ...fields, updated: now };
  try { writeFileSync(join(run, 'state.json'), JSON.stringify(state) + '\n', { mode: 0o600 }); } catch {}
}

/** Map a workflow result, and the receipts it left, onto a tool result. */
function finish(input, result, folder, { attachImages, projectRun }) {
  const scenarios = scenarioResults(input.handoff?.request?.scenarios ?? input.scenarios, resultsOf(result.answer));
  // A run stopped for its spending limit is an error whatever it reported so far.
  const verdict = result.status === 'cost_limit' ? 'ERROR' : overallVerdict(verdictOf(result.answer), scenarios);
  const cost = result.cost !== undefined ? { cost: Number(result.cost.toFixed(6)) } : {};
  if (projectRun) writeState(projectRun, { state: 'finished', finished: new Date().toISOString(), verdict, status: result.status, scenarios, ...cost });
  // Regular files only: agent-created symlinks are never followed.
  const files = filesIn(folder);
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
    structuredContent: { verdict, status: result.status, runId: result.runId ?? null, scenarios, receipts: folder, files, screenshots, ...cost },
  };
}

const scenarios = z.array(z.object({
  name: z.string().min(1),
  steps: z.string().min(1).describe('What to do, in order'),
  expected: z.string().min(1).describe('What must be true afterwards'),
})).optional().describe('Concrete scenarios; without them the bot derives scenarios from `what`');
export const scenariosSchema = scenarios;

const valueOrEnv = z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict();
export const handoffSchema = z.object({
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
function apiTarget({ url, workdir, spec }, env) {
  const lines = [`Test the HTTP API at ${url}.`];
  let container = false;
  try { container = chooseSandbox(env).sandbox === 'container'; } catch {}
  if (container && LOOPBACK.test(url)) {
    lines.push(`Requests run in a container, so use ${url.replace(LOOPBACK, '$1host.docker.internal')} instead. The API must listen on all interfaces (0.0.0.0), not only on 127.0.0.1.`);
  }
  lines.push(`Working folder, copied into the sandbox, with the API's description and test fixtures: ${workdir}.`);
  if (spec) lines.push(`The OpenAPI description is ${spec} in that folder; check responses against it.`);
  return lines;
}

/**
 * A handoff's credentials, resolved to values: names listed in `fromEnv` come
 * from `env` (a CI job's secrets), the rest from the project's .toad/.env.
 */
export function resolveCredentials(folder, credentials, { fromEnv = [], env = process.env } = {}) {
  const refs = Object.entries(credentials ?? {});
  const names = refs.map(([, ref]) => ref.env);
  if (new Set(names).size !== names.length) throw new Error('Each credential must reference a distinct environment name');
  const values = {};
  for (const name of names.filter(n => fromEnv.includes(n))) {
    if (!env[name]) throw new Error(`Missing environment variable for a credential: ${name}`);
    if (env[name].includes('\0')) throw new Error(`Malformed environment variable for a credential: ${name}`);
    values[name] = env[name];
  }
  const rest = Object.fromEntries(refs.filter(([, ref]) => !fromEnv.includes(ref.env)));
  return { ...values, ...resolveSecretReferences(folder, rest) };
}

/**
 * Run a handoff in a project: validate it, record it under .toad/runs/<id>/,
 * and run it. Options:
 *   env          the environment the run inherits (default this process's)
 *   envNames     credential names to take from `env` rather than .toad/.env
 *   sandbox      the CLI sandbox: auto, container, bwrap or none
 *   models       { lead, tester } overriding toad.yaml and the user's choice
 *   maxCost      a spending limit in USD for this run
 *   origin       what started it ('mcp' or 'cli'), recorded in its state
 *   onRun(dir)   called with the run folder once it exists
 */
export async function runProject(input, ctx, options = {}) {
  const { env = process.env, envNames = [], sandbox, models, maxCost, origin = 'mcp', onRun, log } = options;
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
  const secretValues = resolveCredentials(folder, h.credentials, { fromEnv: envNames, env });
  const runEnv = sandbox ? { ...env, TOAD_CLI_SANDBOX: sandbox } : env;
  // The models: options, then toad.yaml, then the user's; another set runs on a copy of the agent.
  const shared = resolveAgent(env);
  if (!shared) throw new Error(NOT_SET_UP);
  // Without an override the agent already runs on the user's models: setup applied them.
  const flags = Object.fromEntries(Object.entries(models ?? {}).filter(([, v]) => v));
  const chosen = Object.keys(flags).length || config.models ? resolveModels(shared, { flags, project: config.models }) : undefined;
  const agent = chosen ? agentFor(shared, chosen, { log }) : shared;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const run = join(folder, 'runs', id);
  ensureDirectory(run);
  ensureDirectory(join(run, 'receipts'));
  ensureDirectory(join(run, 'reports'));
  // JSON is a YAML 1.2 subset and avoids an additional YAML parser dependency.
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(h, null, 2) + '\n', { mode: 0o600 });
  // Recorded at once, so a run that never starts is not shown as running.
  writeState(run, { state: 'starting', origin, ...(chosen ? { models: chosen } : {}), ...(sandbox ? { sandbox } : {}), ...(maxCost !== undefined ? { maxCost } : {}) });
  onRun?.(run);
  try {
    return await projectRun(input, ctx, h, run, secretValues, { agent, env: runEnv, maxCost });
  } catch (error) {
    writeState(run, { state: 'failed', finished: new Date().toISOString(), error: error.message });
    throw error;
  }
}

async function projectRun(input, ctx, h, run, secretValues, { agent, env, maxCost }) {
  const unsandboxed = h.kind !== 'web' && env.TOAD_CLI_SANDBOX === 'none';
  const target = h.kind === 'web' ? [`Test ${h.target.url}.`]
    : h.kind === 'api' ? apiTarget(h.target, env)
      : [`Test the command-line program in the working folder ${h.target.workdir}.`, `Invoke it as: ${h.target.program}`];
  const text = [request(target, { what: h.request.goal, scenarios: h.request.scenarios }),
    ...(h.credentials ? [`Credential roles and secret names: ${JSON.stringify(h.credentials)}. ${h.kind === 'web' ? 'Use each env name as the Playwright secret name' : 'Use each env name as a shell environment variable'}; never print its value.`] : []),
    ...(unsandboxed ? ['There is no sandbox on this machine (--sandbox none): commands run directly on the host in a copy of the working folder, which is their current directory. Use relative paths, not /work, and $HOME, not /home/tester.'] : []),
    ...(h.target.setup?.length ? [`Setup already ran in the sandbox, so every prepared scenario starts with its result: ${h.target.setup.map(c => `\`${c}\``).join('; ')}.`] : []),
    ...(h.kind === 'web' ? [] : [h.allow_installs
      ? 'Installing prerequisites is allowed: a tester may install a missing program, package or module inside the scenario workspace or $HOME, record the install, and retry the step.'
      : 'Installing prerequisites is not allowed: report a missing program, package or module as a missing prerequisite (ERROR) instead of installing it.']),
    ...(h.limitations?.length ? ['Limitations:', ...h.limitations.map(item => `- ${item}`)] : [])].join('\n');
  const setup = h.target.setup?.length ? { commands: h.target.setup, workdir: h.target.workdir, names: (h.request.scenarios ?? []).map(s => s.name) } : undefined;
  // Pi keeps this run's sessions (the lead's and each tester's) with the run, which is how its cost is known.
  const sessions = join(run, 'sessions');
  ensureDirectory(sessions);
  const result = await runTest(text, input, ctx, {
    attachImages: h.kind === 'web' && input.screenshots !== 'paths', projectRun: run, secretValues,
    cliImage: h.kind === 'web' ? undefined : h.target.image, setup, agent, env, maxCost, sessions,
  });
  result.content[0].text += `\n\nHandoff: ${join(run, 'handoff.yaml')}\nReport: ${join(run, 'reports', 'report.md')}`;
  result.structuredContent.run = run;
  return result;
}
