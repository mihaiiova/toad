#!/usr/bin/env node
/**
 * Runs one shell command for a CLI test and records it as a receipt.
 *
 *   node tools/revisor-exec.mjs <receipts-folder> <name> <workdir> <command> [input-file]
 *
 * Run by Forge as the declared commands `run-command` and
 * `run-command-with-input`, from the agent project. The command runs in
 * <workdir> through /bin/sh, with no input (or the input file), a timeout
 * (REVISOR_COMMAND_TIMEOUT_S, default 120 s), and the login secrets from
 * .forge/test-secrets.env in its environment. Secret values are redacted
 * from everything it prints and records. The receipt is
 * <receipts-folder>/<name>.txt. Exits 0 when the command ran, whatever its
 * exit code; 2 on bad arguments.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const MAX_RECORDED = 2 * 1024 * 1024;
const SHOWN_STDOUT = 8000;
const SHOWN_STDERR = 4000;

const fail = (message) => { process.stderr.write(`revisor-exec: ${message}\n`); process.exit(2); };
const [receipts, name, rawWorkdir, command, inputFile] = process.argv.slice(2);
if (!receipts || !name || !rawWorkdir || !command) fail('usage: revisor-exec.mjs <receipts-folder> <name> <workdir> <command> [input-file]');

const root = process.cwd();
const receiptsDir = resolve(root, receipts);
const receiptsRoot = resolve(root, 'data/receipts');
if (receiptsDir !== receiptsRoot && !receiptsDir.startsWith(receiptsRoot + sep)) fail('the receipts folder must be inside data/receipts');
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) fail('the name must be lowercase letters, digits and dashes, like scenario-01-help');
const workdir = resolve(rawWorkdir.startsWith('~/') ? join(homedir(), rawWorkdir.slice(2)) : rawWorkdir);
if (!existsSync(workdir) || !statSync(workdir).isDirectory()) fail(`working folder not found: ${workdir}`);
if (inputFile !== undefined && !existsSync(inputFile)) fail(`input file not found: ${inputFile}`);

/** NAME=value lines from the secrets file; quotes around a value are removed. */
function secrets() {
  let text = '';
  try { text = readFileSync(join(root, '.forge/test-secrets.env'), 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const secret = secrets();
// Longest first, so a value containing another is replaced whole.
const values = Object.entries(secret).filter(([, v]) => v.length >= 4).sort((a, b) => b[1].length - a[1].length);
const redact = (text) => values.reduce((t, [key, value]) => t.split(value).join(`[secret:${key}]`), text);

const timeoutS = Number(process.env.REVISOR_COMMAND_TIMEOUT_S ?? 120);
const started = Date.now();
const child = spawn('/bin/sh', ['-c', command], {
  cwd: workdir,
  env: { ...process.env, ...secret },
  stdio: [inputFile !== undefined ? openSync(inputFile, 'r') : 'ignore', 'pipe', 'pipe'],
  // Its own process group, so a timeout or a cancel stops everything it started.
  detached: true,
});
const out = { stdout: '', stderr: '' };
for (const stream of ['stdout', 'stderr']) {
  child[stream].setEncoding('utf8');
  child[stream].on('data', (chunk) => { if (out[stream].length < MAX_RECORDED) out[stream] += chunk; });
}
let timedOut = false;
const stopGroup = () => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 2000).unref();
};
const timer = setTimeout(() => { timedOut = true; stopGroup(); }, timeoutS * 1000);
// Forge stops the recorder on its own timeout or a cancel; take the command with it.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopGroup(); process.exit(1); });

child.on('close', (code, signal) => {
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const outcome = timedOut ? `timed out after ${timeoutS}s` : `exit ${code ?? signal}`;
  const stdout = redact(out.stdout);
  const stderr = redact(out.stderr);
  const receipt = join(receipts, `${name}.txt`);
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(join(receiptsDir, `${name}.txt`), [
    `$ ${redact(command)}`,
    `workdir: ${workdir}`,
    ...(inputFile !== undefined ? [`input: ${redact(readFileSync(inputFile, 'utf8'))}`] : []),
    `exit: ${timedOut ? `timed out after ${timeoutS}s` : code ?? signal}`,
    `duration: ${seconds}s`,
    '--- stdout ---', stdout,
    '--- stderr ---', stderr,
  ].join('\n'));
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters in the receipt` : text);
  process.stdout.write([
    `${outcome} in ${seconds}s; receipt: ${relative(root, join(root, receipt))}`,
    '--- stdout ---', clip(stdout, SHOWN_STDOUT),
    '--- stderr ---', clip(stderr, SHOWN_STDERR),
  ].join('\n') + '\n');
});
