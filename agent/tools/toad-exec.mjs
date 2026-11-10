#!/usr/bin/env node
/** Deterministic scenario preparation and recorded, sandboxed command execution (container or Bubblewrap). */
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { containerArgs, describeSandbox, hostEnv, hostShell, isReservedSecretName, prepare, sandboxArgs, sandboxEnv, scenarioPath, scenarioSandbox, WORKSPACE_PATH_PATTERN } from './toad-sandbox.mjs';
import { artifactReference, beginExecution, commandAssertions, executionContext, executionOutputPath, finishExecution, noteExecutionError, operationReceipt, readExecutionRecords } from './toad-execution.mjs';
import { privateDir, toadDirs } from './toad-dirs.mjs';

const root = process.cwd();
let execution;
const fail = message => {
  if (process.env.TOAD_EXECUTION_RUN_DIR && operation === 'run') {
    noteExecutionError(process.env.TOAD_EXECUTION_RUN_DIR);
    try { finishExecution(execution, { outcome: 'ERROR', artifacts: [operationReceipt(execution, 'ERROR')], evidenceComplete: true }); } catch {}
  }
  process.stderr.write(`toad-exec: infrastructure error: ${message}\n`); process.exit(2); };
const [operation, ...args] = process.argv.slice(2);
let scenarioName = process.env.TOAD_EXECUTION_SCENARIO_NAME;
const binding = args.indexOf('--scenario-name');
if (binding >= 0) {
  if (binding !== args.length - 2) fail('put --scenario-name <exact-name> last');
  scenarioName = args[binding + 1]; args.splice(binding, 2);
}
if (operation === 'prepare') {
  const [source, network] = args;
  if (!source || args.length > 2) fail('usage: prepare <project-directory> [network-url]');
  try {
    let result;
    if (process.env.TOAD_ATTEMPT_ID) {
      if (realpathSync(resolve(source)) !== realpathSync(process.env.TOAD_ATTEMPT_SOURCE)) throw new Error('Attempt workspace source cannot be changed');
      const workspace = scenarioPath(root, process.env.TOAD_ATTEMPT_ID);
      result = { id: process.env.TOAD_ATTEMPT_ID, workspace, project: join(workspace, 'project'), sandbox: scenarioSandbox(workspace) };
    } else result = prepare(root, source, network);
    const where = result.sandbox.sandbox === 'container' ? `${result.sandbox.runtime} container (${result.sandbox.image})` : result.sandbox.sandbox === 'none' ? 'none: commands run on the host, unsandboxed, in the copied workspace' : 'Bubblewrap';
    const paths = result.sandbox.sandbox === 'none' ? `Working folder: ${result.project} (use it, or relative paths, instead of /work)\nHome: ${join(result.workspace, 'home')}\n` : '';
    process.stdout.write(`Scenario ID: ${result.id}\nWorkspace: ${result.workspace}\nSandbox: ${where}\n${paths}`);
  } catch (error) { fail(error.message); }
  process.exit(0);
}
if (operation !== 'run') fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
const [receipts, name, id, command, inputFile] = args;
if (process.env.TOAD_ATTEMPT_ID && id !== process.env.TOAD_ATTEMPT_ID) fail('Use the owned attempt scenario ID');
if (!receipts || !name || !id || !command || args.length > 5) fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
// The MCP wrapper names this run's receipts folder (inside the project's
// .toad/runs/<id>/); direct ./run calls fall back to the agent's data/receipts.
const allowed = process.env.TOAD_RECEIPTS_DIR;
if (allowed !== undefined && !isAbsolute(allowed)) fail('TOAD_RECEIPTS_DIR must be absolute');
const receiptsDir = resolve(root, receipts), receiptsRoot = allowed ? resolve(allowed) : resolve(root, 'data/receipts');
if (receiptsDir !== receiptsRoot && !receiptsDir.startsWith(receiptsRoot + sep)) fail(`the receipts folder must be inside ${receiptsRoot}`);
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) fail('invalid receipt name');
// The workspace identity becomes the execution session/attempt ID. Diagnose
// malformed identities before record validation can mask them as name errors.
if (!/^[0-9a-f-]{36}$/.test(id)) fail('invalid scenario ID; use the UUID returned by prepare, not a workspace path or scenario name');
try {
  const context = executionContext({ ...process.env, TOAD_EXECUTION_KIND: process.env.TOAD_EXECUTION_KIND ?? 'cli' }, scenarioName);
  if (context) {
    // A prepared workspace is one CLI/API session/attempt across its commands.
    context.sessionId = id; context.attemptId = id;
    context.sequence = Math.max(0, ...readExecutionRecords(context.run).records.filter(r => r.attemptId === id).map(r => r.sequence));
  }
  execution = beginExecution(context, process.env.TOAD_EXECUTION_PHASE === 'before' ? 'beforeAttempt' : process.env.TOAD_EXECUTION_PHASE === 'after' ? 'afterAttempt' : process.env.TOAD_EXECUTION_EXPECT ? 'structuredCommand' : 'runCommand');
} catch { fail('bind an exact scenarioName before running commands'); }
let expected;
try { if (process.env.TOAD_EXECUTION_EXPECT) expected = JSON.parse(process.env.TOAD_EXECUTION_EXPECT); } catch { fail('invalid assertion context'); }
let workspace;
try { workspace = scenarioPath(root, id); } catch (error) { fail(error.message); }
// Mark the workspace as in use so the cache pruning keeps it.
try { const now = new Date(); utimesSync(workspace, now, now); } catch {}
if (inputFile !== undefined && !existsSync(inputFile)) fail('input file not found');
function secrets() {
  if (Object.hasOwn(process.env, 'TOAD_CLI_SECRETS_FILE')) {
    let fd;
    try {
      const path = process.env.TOAD_CLI_SECRETS_FILE;
      if (!path || !path.startsWith('/')) throw new Error();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) throw new Error();
      const values = JSON.parse(readFileSync(fd, 'utf8'));
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !value || value.includes('\0'))) throw new Error();
      return values;
    } catch { fail('cannot safely read project credentials'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  let text = '';
  try { text = readFileSync(join(root, '.faur/test-secrets.env'), 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const secret = secrets();
const hookPhase = process.env.TOAD_EXECUTION_PHASE;
if (hookPhase && !['before', 'after'].includes(hookPhase)) fail('invalid hook phase');
// Never let the shared store change how the host loads or finds Bubblewrap.
const projectCredentials = Object.hasOwn(process.env, 'TOAD_CLI_SECRETS_FILE');
if (Object.keys(secret).some(name => projectCredentials ? isReservedSecretName(name) : /^(LD_|DYLD_|GCONV_PATH$|GLIBC_TUNABLES$|PATH$|HOME$|TMPDIR$|LANG$)/.test(name))) fail('credentials contain a reserved environment name');
const values = Object.entries(secret).filter(([, value]) => value.length > 0).sort((a, b) => b[1].length - a[1].length);
const redact = text => values.reduce((result, [key, value]) => result.split(value).join(`[secret:${key}]`), text);
const timeoutS = Number(process.env.TOAD_COMMAND_TIMEOUT_S ?? 120);
if (!Number.isFinite(timeoutS) || timeoutS <= 0) fail('invalid timeout');
const sandbox = scenarioSandbox(workspace);
// Paths are relative to each copied workspace, not the original project.
let pathEntries = [];
if (process.env.TOAD_CLI_PATH !== undefined) {
  try {
    pathEntries = JSON.parse(process.env.TOAD_CLI_PATH);
    if (!Array.isArray(pathEntries) || pathEntries.length > 20 || pathEntries.some(p => typeof p !== 'string' || !WORKSPACE_PATH_PATTERN.test(p))) throw new Error();
  } catch { fail('invalid workspace PATH entries'); }
}
const pathRoot = sandbox.sandbox === 'none' ? join(workspace, 'project') : '/work';
// Shell-quote the computed path: the unsandboxed workspace can contain quotes.
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const prefix = pathEntries.map(p => quote(sandbox.sandbox === 'none' ? join(pathRoot, p) : posix.join(pathRoot, p))).join(':');
const workload = prefix ? `PATH=${prefix}:"$PATH"; export PATH;\n${command}` : command;
// Secrets reach a container through a private env file, never its command line.
let envDir, envFile;
if (sandbox.sandbox === 'container' && Object.keys(secret).length) {
  if (Object.values(secret).some(value => /[\r\n]/.test(value))) fail('credential values cannot contain line breaks in container runs');
  envDir = mkdtempSync(join(privateDir(join(toadDirs().runtime, 'secrets')), 'toad-cli-env-'));
  envFile = join(envDir, 'cli.env');
  writeFileSync(envFile, Object.entries(secret).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
}
const containerName = `toad-${randomUUID()}`;
const input = inputFile !== undefined ? openSync(inputFile, 'r') : 'ignore';
const started = Date.now();
// Bubblewrap writes the info pipe only after it has initialized the sandbox.
const child = sandbox.sandbox === 'container'
  ? spawn(sandbox.runtime, containerArgs(sandbox, workspace, { name: containerName, envFile, interactive: inputFile !== undefined }, [workload]), { stdio: [input, 'pipe', 'pipe'] })
  : sandbox.sandbox === 'none'
    ? spawn(hostShell(), ['-c', workload], { cwd: join(workspace, 'project'), env: hostEnv(workspace, secret), stdio: [input, 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    : spawn('bwrap', ['--info-fd', '3', ...sandboxArgs(workspace, ['/bin/sh', '-c', workload])], {
    env: sandboxEnv(secret), stdio: [input, 'pipe', 'pipe', 'pipe'], detached: true,
  });
const out = { stdout: '', stderr: '', info: '' };
let outputTruncated = false;
for (const [key, stream] of [['stdout', child.stdout], ['stderr', child.stderr], ['info', child.stdio[3]]]) {
  if (!stream) continue;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const limit = 2 * 1024 * 1024;
    if (out[key].length + chunk.length > limit && key !== 'info') outputTruncated = true;
    if (out[key].length < limit) out[key] += chunk.slice(0, limit - out[key].length);
  });
}
let timedOut = false, interrupted = false, spawnError;
child.on('error', error => { spawnError = error; });
const stop = () => {
  if (sandbox.sandbox === 'container') {
    // Killing the client would leave the container running; stop it by name.
    spawn(sandbox.runtime, ['kill', containerName], { stdio: 'ignore' }).on('error', () => {});
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    return;
  }
  const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 2000).unref();
};
const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutS * 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = true; stop(); });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  let initialized = false;
  if (sandbox.sandbox === 'container') initialized = code !== 125 && !(timedOut && code === null);
  else if (sandbox.sandbox === 'none') initialized = !spawnError;
  else try { initialized = Number.isInteger(JSON.parse(out.info)['child-pid']); } catch {}
  const infrastructureError = !!spawnError || (!initialized && !timedOut);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  // A killed container exits 137; report it as the timeout it was.
  const outcome = infrastructureError ? 'infrastructure error: sandbox did not start' : timedOut ? `timed out after ${timeoutS}s` : `exit ${code ?? signal}`;
  const stdout = redact(out.stdout), stderr = redact(out.stderr);
  const facts = { exitCode: code, stdout, stderr, outputTruncated };
  const unreliable = infrastructureError || timedOut || interrupted || outputTruncated || !Number.isInteger(code);
  const prerequisite = expected && (process.env.TOAD_EXECUTION_KIND === 'api' ? [2, 126, 127].includes(code) : [126, 127].includes(code));
  const assertions = expected && !prerequisite && !infrastructureError && !timedOut && !interrupted ? commandAssertions(expected, facts, process.env.TOAD_EXECUTION_KIND) : [];
  const observedFailure = assertions.some(a => a.result === 'FAIL');
  let executionOutcome = hookPhase ? interrupted ? 'cancelled' : unreliable || code !== 0 ? 'ERROR' : 'completed' : interrupted ? 'cancelled' : prerequisite ? 'ERROR' : observedFailure ? 'FAIL' : unreliable || expected && !assertions.length ? 'ERROR' : expected ? 'PASS' : 'completed';
  let evidenceError = false;
  const receipt = join(receiptsDir, `${name}.txt`);
  try {
    // Validate every ancestor before creating descendants or writing a receipt.
    const ensureReceiptDir = dir => {
      if (dir === resolve(dir, '..')) return;
      ensureReceiptDir(resolve(dir, '..'));
      try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe receipt directory');
    };
    ensureReceiptDir(receiptsDir);
    if (execution) executionOutputPath(execution.run, receipt);
    writeFileSync(receipt, [`$ ${redact(command)}`, `scenario: ${id}`, `workspace: ${workspace}`, `sandbox: ${describeSandbox(sandbox)}`, ...(inputFile !== undefined ? [`input: ${redact(readFileSync(inputFile, 'utf8'))}`] : []), `result: ${outcome}`, `duration: ${seconds}s`, ...(outputTruncated ? ['output: truncated (2 MiB per stream limit)'] : []), '--- stdout ---', stdout, '--- stderr ---', stderr].join('\n'), { flag: 'wx', mode: 0o600 });
    if (execution) {
      const steps = assertions.map((assertion, i) => ({ index: i + 1, operation: assertion.kind, startedAt: execution.record.startedAt, finishedAt: new Date().toISOString(), outcome: assertion.result, assertion }));
      finishExecution(execution, { outcome: executionOutcome, steps, artifacts: [artifactReference(execution.run, receipt, 'receipt')], evidenceComplete: true, ...(expected && steps.length ? { verification: { source: 'machine', executionIds: [] } } : {}) });
    }
  } catch {
    evidenceError = true;
    if (executionOutcome !== 'FAIL') executionOutcome = 'ERROR';
    if (process.env.TOAD_EXECUTION_RUN_DIR) noteExecutionError(process.env.TOAD_EXECUTION_RUN_DIR);
    try { finishExecution(execution, { outcome: executionOutcome, steps: assertions.map((assertion, i) => ({ index: i + 1, operation: assertion.kind, startedAt: execution.record.startedAt, finishedAt: new Date().toISOString(), outcome: assertion.result, assertion })), evidenceComplete: false }); } catch {}
  }
  const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters in the receipt` : text;
  if (process.env.TOAD_EXEC_JSON === '1') {
    process.stdout.write(JSON.stringify({ infrastructureError, timedOut, interrupted, exitCode: code, signal, stdout, stderr, outputTruncated, receipt, evidenceError, executionOutcome, executionId: execution?.record.id, assertions }) + '\n');
  } else {
    process.stdout.write([...(evidenceError ? ['ERROR: required receipt or execution evidence could not be saved'] : []), ...(execution ? [`Execution ID: ${execution.record.id} (operation evidence; attest scenario completion explicitly)`] : []), `${outcome} in ${seconds}s; receipt: ${receipt}`, '--- stdout ---', clip(stdout, 8000), '--- stderr ---', clip(stderr, 4000)].join('\n') + '\n');
  }
  if (executionOutcome === 'FAIL') process.exitCode = 1;
  else if (executionOutcome === 'ERROR' || executionOutcome === 'cancelled') process.exitCode = 2;
});
