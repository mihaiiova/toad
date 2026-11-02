#!/usr/bin/env node
/** Deterministic scenario preparation and recorded Bubblewrap command execution. */
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isReservedSecretName, prepare, sandboxArgs, sandboxEnv, scenarioPath } from './revisor-sandbox.mjs';

const root = process.cwd();
const fail = message => { process.stderr.write(`revisor-exec: infrastructure error: ${message}\n`); process.exit(2); };
const [operation, ...args] = process.argv.slice(2);
if (operation === 'prepare') {
  const [source, network] = args;
  if (!source || args.length > 2) fail('usage: prepare <project-directory> [network-url]');
  try {
    const result = prepare(root, source, network);
    process.stdout.write(`Scenario ID: ${result.id}\nWorkspace: ${result.workspace}\n`);
  } catch (error) { fail(error.message); }
  process.exit(0);
}
if (operation !== 'run') fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
const [receipts, name, id, command, inputFile] = args;
if (!receipts || !name || !id || !command || args.length > 5) fail('usage: run <receipts-folder> <name> <scenario-id> <command> [input-file]');
const receiptsDir = resolve(root, receipts), receiptsRoot = resolve(root, 'data/receipts');
if (receiptsDir !== receiptsRoot && !receiptsDir.startsWith(receiptsRoot + sep)) fail('the receipts folder must be inside data/receipts');
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) fail('invalid receipt name');
let workspace;
try { workspace = scenarioPath(root, id); } catch (error) { fail(error.message); }
if (inputFile !== undefined && !existsSync(inputFile)) fail('input file not found');
function secrets() {
  if (Object.hasOwn(process.env, 'REVISOR_CLI_SECRETS_FILE')) {
    let fd;
    try {
      const path = process.env.REVISOR_CLI_SECRETS_FILE;
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
  try { text = readFileSync(join(root, '.forge/test-secrets.env'), 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const secret = secrets();
// Never let the shared store change how the host loads or finds Bubblewrap.
const projectCredentials = Object.hasOwn(process.env, 'REVISOR_CLI_SECRETS_FILE');
if (Object.keys(secret).some(name => projectCredentials ? isReservedSecretName(name) : /^(LD_|DYLD_|GCONV_PATH$|GLIBC_TUNABLES$|PATH$|HOME$|TMPDIR$|LANG$)/.test(name))) fail('credentials contain a reserved environment name');
const values = Object.entries(secret).filter(([, value]) => value.length > 0).sort((a, b) => b[1].length - a[1].length);
const redact = text => values.reduce((result, [key, value]) => result.split(value).join(`[secret:${key}]`), text);
const timeoutS = Number(process.env.REVISOR_COMMAND_TIMEOUT_S ?? 120);
if (!Number.isFinite(timeoutS) || timeoutS <= 0) fail('invalid timeout');
const started = Date.now();
// The info pipe is written only after Bubblewrap has initialized the sandbox.
const child = spawn('bwrap', ['--info-fd', '3', ...sandboxArgs(workspace, ['/bin/sh', '-c', command])], {
  env: sandboxEnv(secret), stdio: [inputFile !== undefined ? openSync(inputFile, 'r') : 'ignore', 'pipe', 'pipe', 'pipe'], detached: true,
});
const out = { stdout: '', stderr: '', info: '' };
for (const [key, stream] of [['stdout', child.stdout], ['stderr', child.stderr], ['info', child.stdio[3]]]) {
  stream.setEncoding('utf8');
  stream.on('data', chunk => { if (out[key].length < 2 * 1024 * 1024) out[key] += chunk; });
}
let timedOut = false, interrupted = false, spawnError;
child.on('error', error => { spawnError = error; });
const stopGroup = () => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
};
const timer = setTimeout(() => { timedOut = true; stopGroup(); }, timeoutS * 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = true; stopGroup(); });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  let initialized = false;
  try { initialized = Number.isInteger(JSON.parse(out.info)['child-pid']); } catch {}
  const infrastructureError = !!spawnError || !initialized;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const outcome = infrastructureError ? 'infrastructure error: sandbox did not start' : timedOut ? `timed out after ${timeoutS}s` : `exit ${code ?? signal}`;
  const stdout = redact(out.stdout), stderr = redact(out.stderr);
  mkdirSync(receiptsDir, { recursive: true });
  const receipt = join(receiptsDir, `${name}.txt`);
  writeFileSync(receipt, [`$ ${redact(command)}`, `scenario: ${id}`, `workspace: ${workspace}`, ...(inputFile !== undefined ? [`input: ${redact(readFileSync(inputFile, 'utf8'))}`] : []), `result: ${outcome}`, `duration: ${seconds}s`, '--- stdout ---', stdout, '--- stderr ---', stderr].join('\n'));
  const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters in the receipt` : text;
  process.stdout.write([`${outcome} in ${seconds}s; receipt: ${relative(root, receipt)}`, '--- stdout ---', clip(stdout, 8000), '--- stderr ---', clip(stderr, 4000)].join('\n') + '\n');
  if (infrastructureError) process.exitCode = 2;
  else if (interrupted) process.exitCode = 1;
});
