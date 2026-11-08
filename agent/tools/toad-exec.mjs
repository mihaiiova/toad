#!/usr/bin/env node
/** Deterministic scenario preparation and recorded, sandboxed command execution (container or Bubblewrap). */
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { containerArgs, describeSandbox, hostEnv, hostShell, isReservedSecretName, prepare, sandboxArgs, sandboxEnv, scenarioPath, scenarioSandbox, WORKSPACE_PATH_PATTERN } from './toad-sandbox.mjs';
import { privateDir, toadDirs } from './toad-dirs.mjs';

const root = process.cwd();
const fail = message => { process.stderr.write(`toad-exec: infrastructure error: ${message}\n`); process.exit(2); };
const [operation, ...args] = process.argv.slice(2);
if (operation === 'prepare') {
  const [source, network] = args;
  if (!source || args.length > 2) fail('usage: prepare <project-directory> [network-url]');
  try {
    const result = prepare(root, source, network);
    const where = result.sandbox.sandbox === 'container' ? `${result.sandbox.runtime} container (${result.sandbox.image})` : result.sandbox.sandbox === 'none' ? 'none: commands run on the host, unsandboxed, in the copied workspace' : 'Bubblewrap';
    const paths = result.sandbox.sandbox === 'none' ? `Working folder: ${result.project} (use it, or relative paths, instead of /work)\nHome: ${join(result.workspace, 'home')}\n` : '';
    process.stdout.write(`Scenario ID: ${result.id}\nWorkspace: ${result.workspace}\nSandbox: ${where}\n${paths}`);
  } catch (error) { fail(error.message); }
  process.exit(0);
}
if (operation !== 'run') fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
const [receipts, name, id, command, inputFile] = args;
if (!receipts || !name || !id || !command || args.length > 5) fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
// The MCP wrapper names this run's receipts folder (inside the project's
// .toad/runs/<id>/); direct ./run calls fall back to the agent's data/receipts.
const allowed = process.env.TOAD_RECEIPTS_DIR;
if (allowed !== undefined && !isAbsolute(allowed)) fail('TOAD_RECEIPTS_DIR must be absolute');
const receiptsDir = resolve(root, receipts), receiptsRoot = allowed ? resolve(allowed) : resolve(root, 'data/receipts');
if (receiptsDir !== receiptsRoot && !receiptsDir.startsWith(receiptsRoot + sep)) fail(`the receipts folder must be inside ${receiptsRoot}`);
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) fail('invalid receipt name');
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
  mkdirSync(receiptsDir, { recursive: true });
  const receipt = join(receiptsDir, `${name}.txt`);
  writeFileSync(receipt, [`$ ${redact(command)}`, `scenario: ${id}`, `workspace: ${workspace}`, `sandbox: ${describeSandbox(sandbox)}`, ...(inputFile !== undefined ? [`input: ${redact(readFileSync(inputFile, 'utf8'))}`] : []), `result: ${outcome}`, `duration: ${seconds}s`, ...(outputTruncated ? ['output: truncated (2 MiB per stream limit)'] : []), '--- stdout ---', stdout, '--- stderr ---', stderr].join('\n'));
  const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters in the receipt` : text;
  if (process.env.TOAD_EXEC_JSON === '1') {
    process.stdout.write(JSON.stringify({ infrastructureError, timedOut, interrupted, exitCode: code, signal, stdout, stderr, outputTruncated, receipt }) + '\n');
  } else {
    process.stdout.write([`${outcome} in ${seconds}s; receipt: ${receipt}`, '--- stdout ---', clip(stdout, 8000), '--- stderr ---', clip(stderr, 4000)].join('\n') + '\n');
  }
  if (infrastructureError) process.exitCode = 2;
  else if (interrupted) process.exitCode = 1;
});
