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
import { executionScenarioId, readExecutionRecords } from '../agent/tools/toad-execution.mjs';
import { readdirSync, readFileSync, statSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runScenarioLifecycle } from './scenario-lifecycle.mjs';
import { attemptSchema, providerCredentialName, HOOK_RECORDING_REASON } from './attempt-schema.mjs';
import { definitionDocument, definitionError, validateDefinition } from './definition-diagnostics.mjs';
import { resolveSecretReferences } from './project-secrets.mjs';
import { chooseSandbox, isReservedSecretName } from '../agent/tools/toad-sandbox.mjs';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';
import { acquireSlot } from './slots.mjs';
import { overallVerdict, resultsOf, scenarioResults, verdictOf } from './results.mjs';
import { checkIgnore, ensureDirectory, pathEntries, projectFolder, readProjectConfig, readRegular, registerProject, withDefaults } from './projects.mjs';
import { finalizeCliCandidates, finalizeWebCandidates, markNotRecordable } from './recordings.mjs';
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
export async function runTest(text, input, ctx, { attachImages, projectRun, secretValues, cliImage, cliPath, cliRecording, webTarget, setup, agent = resolveAgent(), env: baseEnv = process.env, maxCost, sessions }) {
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
    delete env.TOAD_CLI_PATH;
    delete env.TOAD_EXEC_JSON;
    delete env.TOAD_RECORDING_ENABLED;
    delete env.TOAD_WEB_TARGET_URL;
    for (const key of Object.keys(env)) if (key.startsWith('TOAD_ATTEMPT_')) delete env[key];
    for (const key of ['TOAD_EXECUTION_RUN_DIR', 'TOAD_EXECUTION_SCENARIOS', 'TOAD_EXECUTION_SCENARIO_NAME', 'TOAD_EXECUTION_MODE', 'TOAD_EXECUTION_KIND', 'TOAD_EXECUTION_EXPECT', 'TOAD_EXECUTION_PHASE']) delete env[key];
    if (projectRun && input.handoff) {
      env.TOAD_EXECUTION_KIND = input.handoff.kind;
      env.TOAD_EXECUTION_RUN_DIR = projectRun;
      env.TOAD_EXECUTION_SCENARIOS = JSON.stringify((input.handoff.request.scenarios ?? []).map(s => s.name));
      env.TOAD_EXECUTION_MODE = 'agent';
    }
    if (webTarget) env.TOAD_WEB_TARGET_URL = webTarget;
    if (cliRecording) env.TOAD_RECORDING_ENABLED = { api: 'api-v1', web: 'web-v1' }[input.handoff?.kind] ?? 'cli-v1';
    if (cliPath?.length) env.TOAD_CLI_PATH = JSON.stringify(cliPath);
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
    const checkBudget = () => {
      spent = sessionCost(sessions);
      if (maxCost !== undefined && spent > maxCost && !overBudget) { overBudget = true; message = 'Stopping: over the spending limit…'; budget.abort(); }
    };
    const meter = sessions && setInterval(checkBudget, 2000);
    // Hook workflows share this one run deadline and cost meter, not one allowance each.
    const runDeadline = input.handoff?.attempt && setTimeout(() => budget.abort(), Number(env.TOAD_TEST_TIMEOUT_MS) || run.timeoutMinutes * 60000);
    if (ctx.signal.aborted) budget.abort();
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
      result ??= input.handoff?.attempt
        ? await runHookScenarios(agent, run, input.handoff, env, folder, budget.signal, tick, sessions, secretValues ?? {}, checkBudget)
        : await runWorkflow(agent, run, budget.signal, tick, env, sessions ? ['--session-dir', sessions] : []);
    } finally {
      if (runDeadline) clearTimeout(runDeadline);
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
    if (signal?.aborted) return done({ code: 2, out: '', err: 'Cancelled before command launch' });
    const child = spawn(process.execPath, [join(agent, 'tools', 'toad-exec.mjs'), ...args], { cwd: agent, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err += d; });
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', error => { err += error.message; });
    child.on('close', code => { signal?.removeEventListener('abort', cancel); done({ code, out, err }); });
  });
}

/** Native ownership for hook-bearing scenarios; the specialist never owns finally. */
async function runHookScenarios(agent, run, h, env, folder, signal, tick, sessions, secretValues, checkBudget) {
  const results = [], notes = [];
  let status = 'ok', processCleanupIncomplete = false;
  const hooks = h.attempt;
  const workdir = h.kind === 'web' ? hooks.workdir : h.target.workdir;
  for (const scenario of h.request.scenarios) {
    checkBudget();
    let snapshot;
    const lifecycle = await runScenarioLifecycle({ ...hooks, signal, timeoutSeconds: hooks.timeout_seconds ?? 120, cleanupTimeoutSeconds: hooks.cleanup_timeout_seconds ?? 30 }, {
      async prepare(mainSignal) {
        const dir = join(runDir(), 'attempts');
        ensureDirectory(dir);
        const prepared = await toolCommand(agent, ['prepare', workdir], env, mainSignal);
        const id = /Scenario ID: (\S+)/.exec(prepared.out)?.[1];
        const workspace = /Workspace: (.+)/.exec(prepared.out)?.[1]?.trim();
        if (!id || !workspace) return null;
        const contextEnv = { ...env, TOAD_ATTEMPT_ID: id, TOAD_ATTEMPT_SOURCE: workdir, TOAD_EXECUTION_SCENARIO_NAME: scenario.name, TOAD_EXECUTION_SCENARIOS: JSON.stringify([scenario.name]) };
        return { id, workspace, env: contextEnv };
      },
      async command(context, phase, command, index, commandSignal) {
        if (!context.hookFile) {
          context.secretDir ??= mkdtempSync(join(privateDir(join(toadDirs().runtime, 'secrets')), 'toad-hooks-'));
          const file = join(context.secretDir, 'selected.json');
          const selected = Object.fromEntries((hooks.credentials ?? []).map(name => [name, secretValues[name]]));
          writeFileSync(file, JSON.stringify(selected), { flag: 'wx', mode: 0o600 });
          context.hookFile = file;
        }
        const hookEnv = { ...context.env, TOAD_CLI_SECRETS_FILE: context.hookFile, TOAD_EXECUTION_PHASE: phase, TOAD_EXEC_JSON: '1', TOAD_COMMAND_TIMEOUT_S: String(phase === 'after' ? hooks.cleanup_timeout_seconds ?? 30 : hooks.timeout_seconds ?? 120) };
        delete hookEnv.TOAD_EXECUTION_EXPECT;
        const commandResult = await toolCommand(agent, ['run', join(folder, 'attempts', context.id, phase), `${String(index + 1).padStart(2, '0')}-${phase}`, context.id, command], hookEnv, commandSignal);
        try {
          const fact = JSON.parse(commandResult.out);
          return commandResult.code === 0 && fact.exitCode === 0 && fact.executionOutcome === 'completed' && !fact.evidenceError;
        } catch { return false; }
      },
      async product(context, mainSignal) {
        const product = await runWorkflow(agent, { ...run, request: `${run.request}\nScenario for this attempt ONLY:\nScenarios:\n1. "${scenario.name}": ${scenario.steps}; expected: ${scenario.expected}\nNative fixture preparation is complete. Owned scenario ID: ${context.id}. Workspace: ${context.workspace}. Do not rerun before/after hooks. Use this ID, not a fresh workspace. Capture failure evidence before returning. Report only this scenario.` }, mainSignal, tick, context.env, sessions ? ['--session-dir', sessions] : []);
        context.processCleanupIncomplete = product.cleanup === 'incomplete';
        processCleanupIncomplete ||= context.processCleanupIncomplete;
        return product;
      },
      capture(context, product) {
        const evidence = readExecutionRecords(runDir());
        const attemptRecords = evidence.records.filter(r => r.scenarioName === scenario.name);
        const incomplete = evidence.errors.length > 0 || attemptRecords.some(r => !r.evidenceComplete);
        const records = attemptRecords.filter(r => !r.phase);
        const reported = scenarioResults([scenario], resultsOf(product?.answer))[0].result;
        const failed = reported === 'FAIL' || records.some(r => r.outcome === 'FAIL' || r.steps.some(s => s.assertion?.result === 'FAIL'));
        snapshot = { scenarioName: scenario.name, attemptId: context.id, capturedAt: new Date().toISOString(), result: failed ? 'FAIL' : !incomplete && product?.status === 'ok' ? reported : 'ERROR', executionIds: records.map(r => r.id) };
        const redact = text => Object.values(secretValues).filter(Boolean).sort((a, b) => b.length - a.length).reduce((out, value) => out.split(value).join('[REDACTED]'), text);
        writeFileSync(join(runDir(), 'reports', `${context.id}.md`), redact(product?.answer ?? 'No product report: fixture preparation or product execution did not complete.'), { flag: 'wx', mode: 0o600 });
        // Metadata is outside receipts and contains facts only, never the model's raw text.
        writeFileSync(join(runDir(), 'attempts', `${context.id}.json`), JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 });
        if (incomplete) throw new Error('Required attempt evidence is incomplete');
      },
      close(context, { retain }) {
        if (context.secretDir) rmSync(context.secretDir, { recursive: true, force: true });
        const evidence = readExecutionRecords(runDir());
        if (!retain && !context.processCleanupIncomplete && !evidence.errors.length && !evidence.records.some(r => r.attemptId === context.id && !r.evidenceComplete)) rmSync(context.workspace, { recursive: true, force: true });
      },
    });
    const failed = snapshot?.result === 'FAIL';
    const error = lifecycle.executionError || lifecycle.preparationError || lifecycle.cleanupError || lifecycle.evidenceError || lifecycle.cancelled || lifecycle.product?.status !== 'ok';
    results.push({ name: scenario.name, result: failed ? 'FAIL' : error ? 'ERROR' : snapshot?.result ?? 'ERROR' });
    if (error) {
      status = signal.aborted ? 'cancelled' : 'fixture_error';
      notes.push(`${scenario.name}: ${lifecycle.preparationError ? 'fixture preparation failed; product skipped; ' : ''}${lifecycle.executionError ? 'product execution errored; ' : ''}${lifecycle.cleanupUnavailable ? 'cleanup unavailable: no owned sandbox; ' : ''}${lifecycle.cleanupError ? 'fixture cleanup failed or exceeded its separate deadline; ' : ''}${lifecycle.evidenceError ? 'failure evidence unavailable; workspace retained; ' : ''}${lifecycle.cancelled ? 'attempt cancelled or timed out; ' : ''}`);
    }
  }
  const verdict = overallVerdict('PASS', results);
  return { status, answer: [`Verdict: ${verdict}`, 'Results:', ...results.map(s => `- ${s.result} | ${s.name}`), '', ...notes].join('\n'), cleanup: processCleanupIncomplete || notes.some(n => n.includes('cleanup failed') || n.includes('cleanup unavailable')) ? 'incomplete' : 'complete' };

  function runDir() { return env.TOAD_EXECUTION_RUN_DIR; }
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
  // Setup is run-level infrastructure, not an unattributed scenario operation.
  for (const key of Object.keys(setupEnv)) if (key.startsWith('TOAD_EXECUTION_')) delete setupEnv[key];
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
  const execution = projectRun && input.handoff ? readExecutionRecords(projectRun) : null;
  const failedRecord = r => r.outcome === 'FAIL' || r.assertion?.result === 'FAIL' || r.steps.some(s => s.assertion?.result === 'FAIL');
  let incomplete = !!execution && (scenarios.some(s => s.missing) || execution.errors.length > 0 || !execution.records.length || execution.records.some(r => !r.evidenceComplete || ['running', 'ERROR', 'cancelled'].includes(r.outcome) || r.steps.some(s => s.assertion?.result === 'ERROR')));
  if (execution) {
    if (!scenarios.length && input.handoff.kind !== 'web') {
      for (const name of new Set(execution.records.map(r => r.scenarioName))) {
        const records = execution.records.filter(r => r.scenarioName === name);
        const completed = records.filter(r => !r.phase && r.verification && r.evidenceComplete && r.finishedAt);
        if (!completed.some(r => r.outcome === 'PASS')) incomplete = true;
        scenarios.push({ name, result: records.some(failedRecord) ? 'FAIL' : completed.some(r => r.outcome === 'PASS') ? 'PASS' : 'ERROR' });
      }
    }
    for (const scenario of scenarios) {
      const records = execution.records.filter(r => r.scenarioId === executionScenarioId(scenario.name));
      if (records.some(failedRecord)) scenario.result = 'FAIL';
      else if (scenario.result === 'PASS' && !records.some(r => !r.phase && r.evidenceComplete && r.finishedAt !== null && ['completed', 'PASS'].includes(r.outcome) && (r.kind === 'web' || !!r.verification))) {
        scenario.result = 'ERROR';
        incomplete = true;
      }
    }
  }
  if (incomplete) {
    for (const s of scenarios) if (s.result === 'PASS') s.result = 'ERROR';
    result = { ...result, status: result.status === 'ok' ? 'evidence_error' : result.status, message: [result.message, 'Required execution evidence or explicit scenario completion is incomplete'].filter(Boolean).join('. ') };
  }
  const observedFailure = execution?.records.some(failedRecord);
  // Spending limits cannot hide an already observed product failure.
  const verdict = overallVerdict(observedFailure ? 'FAIL' : result.status === 'cost_limit' ? 'ERROR' : incomplete && verdictOf(result.answer) !== 'FAIL' ? 'ERROR' : verdictOf(result.answer), scenarios);
  const cost = result.cost !== undefined ? { cost: Number(result.cost.toFixed(6)) } : {};
  if (projectRun) {
    writeState(projectRun, { state: 'finished', finished: new Date().toISOString(), verdict, status: result.status, ...(result.cleanup ? { cleanup: result.cleanup } : {}), scenarios, ...cost });
    try {
      const handoff = JSON.parse(readFileSync(join(projectRun, 'handoff.yaml'), 'utf8'));
      if (handoff?.attempt) {
        for (const scenario of handoff.request.scenarios) {
          try { markNotRecordable(projectRun, handoff.kind, scenario, 'attempt-hooks'); } catch {}
        }
      } else if (handoff?.kind === 'web') finalizeWebCandidates(projectRun, handoff, scenarios);
      else finalizeCliCandidates(projectRun, handoff, scenarios);
    } catch { /* Capture never changes the test result. */ }
  }
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
    path: pathEntries.describe('cli/api: workspace-relative directories prepended to PATH for setup and scenario commands'),
    setup: z.array(z.string().min(1)).max(20).optional().describe('cli/api: shell commands Toad runs once in the sandbox before any scenario, e.g. installing a pinned tool; every scenario starts from the result'),
  }).strict().optional()
    .describe('Omitted fields come from the project\'s .toad/toad.yaml'),
  attempt: attemptSchema.optional(),
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

/** Static definition checks shared by project execution and CLI preflight. */
export function validateProjectHandoff(h, { suite } = {}) {
  validateDefinition({ data: h }, handoffSchema, 'handoff');
  h = { ...h, target: h.target ?? {} };
  const fail = (path, explanation, remedy) => {
    const document = suite?.path ? definitionDocument(readRegular(suite.path), suite.path) : null;
    throw definitionError(document, { path }, { file: suite?.path ?? 'handoff', explanation, remedy });
  };
  if (h.attempt) {
    const names = (h.request.scenarios ?? []).map(s => s.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) fail(['request', 'scenarios'], 'Attempt scenario names must be distinct', 'Supply one unique name per scenario.');
    if (!h.request.scenarios?.length) fail(['request', 'scenarios'], 'Attempt hooks require explicit named scenarios', 'Supply request.scenarios before using attempt hooks.');
    if (h.kind === 'web' && !h.attempt.workdir) fail(['attempt', 'workdir'], 'Web hooks require an explicit trusted fixture workdir', 'Set attempt.workdir to the trusted fixture folder; no host shell or browser scripts are provided.');
    if (h.kind !== 'web' && h.attempt.workdir) {
      let same = false;
      try { same = realpathSync(h.attempt.workdir) === realpathSync(h.target.workdir); } catch {}
      if (!same) fail(['attempt', 'workdir'], 'Hooks must use the tested workspace', 'Omit attempt.workdir or set it equal to target.workdir.');
    }
    const selected = h.attempt.credentials ?? [];
    if (new Set(selected).size !== selected.length || selected.some(name => isReservedSecretName(name) || providerCredentialName(name) || !Object.values(h.credentials ?? {}).some(ref => ref.env === name))) fail(['attempt', 'credentials'], 'Invalid hook credential selection', 'Select distinct non-reserved application names from handoff.credentials; never select model/provider keys.');
    if (Object.values(h.credentials ?? {}).some(ref => isReservedSecretName(ref.env) || providerCredentialName(ref.env))) fail(['credentials'], 'Unsafe credential reference for a hook-bearing run', 'Use application-only credential references, not reserved or provider keys.');
  }
  if ((h.kind === 'web' || h.kind === 'api') && !h.target.url) fail(['target', 'url'], 'Missing effective target URL', `Set target.url in the suite/handoff or ${h.kind}.url in .toad/toad.yaml.`);
  if (h.kind === 'cli' && (!h.target.workdir || !h.target.program)) fail(['target', !h.target.workdir ? 'workdir' : 'program'], 'Missing CLI target', 'Set target.workdir and target.program in the suite/handoff, or cli defaults in .toad/toad.yaml.');
  if (h.kind !== 'web' && Object.values(h.credentials ?? {}).some(ref => isReservedSecretName(ref.env))) fail(['credentials'], 'Reserved credential environment reference', 'Use a non-reserved application credential environment name.');
  if (h.kind === 'web' && (h.target.setup?.length || h.target.path?.length || h.allow_installs)) fail(h.allow_installs ? ['allow_installs'] : ['target', h.target.setup?.length ? 'setup' : 'path'], 'Unsupported web execution option', 'Remove setup, path and allow_installs from web definitions; they apply only to CLI/API.');
  return h;
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
  input = { ...input, handoff: validateDefinition({ data: input.handoff }, handoffSchema, 'handoff') };
  if (!lstatSync(folder).isDirectory() || !lstatSync(join(folder, 'runs')).isDirectory()) throw new Error('Run setup_project first');
  checkIgnore(join(folder, '.gitignore'));
  const config = readProjectConfig(folder);
  const h = withDefaults(input.handoff, config, dirname(folder));
  input = { ...input, timeout_minutes: input.timeout_minutes ?? config.timeout_minutes };
  registerProject(dirname(folder));
  validateProjectHandoff(h);
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
  const unsandboxed = (h.kind !== 'web' || h.attempt) && env.TOAD_CLI_SANDBOX === 'none';
  const target = h.kind === 'web' ? [`Test ${h.target.url}.`, 'This is the authoritative target for every navigation. Resolve root-relative paths such as /pricing against this target. Do not use a different origin or an older target. Pass root-relative goto URLs to cli_run_structured_web; it resolves and enforces the effective target.']
    : h.kind === 'api' ? apiTarget(h.target, env)
      : [`Test the command-line program in the working folder ${h.target.workdir}.`, `Invoke it as: ${h.target.program}`];
  const cliRecording = !h.attempt && ['cli', 'api', 'web'].includes(h.kind) && !Object.keys(h.credentials ?? {}).length && !h.allow_installs && !h.target.setup?.length && !h.target.path?.length;
  const text = [request(target, { what: h.request.goal, scenarios: h.attempt ? [] : h.request.scenarios }),
    ...(cliRecording && h.kind === 'api' ? ['For one-request scenarios use cli_run_structured_api with payload {method,url,headers,body,expect:{status,body:{equals:STRING or contains:STRING}}}, plus scenario ID, receipts, name and capture:{scenarioName:EXACT_NAME,complete:true}. The tool requires Node with fetch in the sandbox. Headers support only accept and content-type. No credentials or sensitive literals. Attest complete only when this request and assertion cover the whole scenario; otherwise use normal tools.'] : []),
    ...(cliRecording && h.kind === 'web' ? ['For a scenario fully covered by navigation, clicks, fills and explicit checks, a web-tester may run it with cli_run_structured_web: receipts (the scenario folder), name (e.g. 01-structured), payload {steps:[...]} and capture:{scenarioName:EXACT_NAME,complete:true}. Steps: {action:"goto",url}, {action:"click",target}, {action:"fill",target,value}, {action:"expectVisible",target}, {action:"expectText",target,contains}, {action:"expectUrl",path}; target is {role,name}, {label} or {text}, matched exactly. Start with goto under the app URL and end with a check. Only trusted, non-secret literals; never sign-in, password or token fields. Attest complete only when the steps and checks cover the whole scenario, and run it once, as the scenario\'s only structured run; otherwise use the browser tools. Do not weaken the scenario to record it.'] : []),
    ...(cliRecording && h.kind === 'cli' ? ['For a scenario fully testable by one structured CLI command and explicit exit-code and stdout assertion, use cli_run_structured_command with capture.scenarioName set to the exact scenario name and capture.complete true. Use it as the only command receipt in that scenario. Set complete true only if this one action and assertion cover every step and expected outcome. Only trusted, non-secret literal data is supported. Otherwise use normal tools; do not weaken the scenario to record it.'] : []),
    ...(h.attempt ? [`${HOOK_RECORDING_REASON}. Native preparation owns one disposable workspace per attempt. Do not run hooks yourself or create another workspace. The supplied scenario ID must be used for all commands; collect failure evidence before returning. No persistent daemons. Web hooks do not grant browser testers shell tools.`] : []),
    ...(h.credentials ? [`Credential roles and secret names: ${JSON.stringify(h.credentials)}. ${h.kind === 'web' ? 'Use each env name as the Playwright secret name' : 'Use each env name as a shell environment variable'}; never print its value.`] : []),
    ...(unsandboxed ? ['There is no sandbox on this machine (--sandbox none): commands run directly on the host in a copy of the working folder, which is their current directory. Use relative paths, not /work, and $HOME, not /home/tester.'] : []),
    ...(h.target.setup?.length ? [`Setup already ran in the sandbox, so every prepared scenario starts with its result: ${h.target.setup.map(c => `\`${c}\``).join('; ')}.`] : []),
    ...(h.kind !== 'web' && h.target.path?.length ? [`Each command has these workspace-relative directories prepended to PATH: ${h.target.path.join(', ')}.`] : []),
    ...(h.kind === 'web' ? [] : [h.allow_installs
      ? 'Installing prerequisites is allowed: a tester may install a missing program, package or module inside the scenario workspace or $HOME, record the install, and retry the step.'
      : 'Installing prerequisites is not allowed: report a missing program, package or module as a missing prerequisite (ERROR) instead of installing it.']),
    ...(h.limitations?.length ? ['Limitations:', ...h.limitations.map(item => `- ${item}`)] : [])].join('\n');
  const setup = h.target.setup?.length ? { commands: h.target.setup, workdir: h.target.workdir, names: (h.request.scenarios ?? []).map(s => s.name) } : undefined;
  // Pi keeps this run's sessions (the lead's and each tester's) with the run, which is how its cost is known.
  const sessions = join(run, 'sessions');
  ensureDirectory(sessions);
  const result = await runTest(text, { ...input, handoff: h }, ctx, {
    attachImages: h.kind === 'web' && input.screenshots !== 'paths', projectRun: run, secretValues,
    cliImage: h.kind === 'web' && !h.attempt ? undefined : h.target.image, cliPath: h.kind === 'web' ? undefined : h.target.path, cliRecording, webTarget: h.kind === 'web' ? h.target.url : undefined, setup, agent, env, maxCost, sessions,
  });
  result.content[0].text += `\n\nHandoff: ${join(run, 'handoff.yaml')}\nReport: ${join(run, 'reports', 'report.md')}`;
  result.structuredContent.run = run;
  return result;
}
