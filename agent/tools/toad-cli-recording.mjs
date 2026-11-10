/** Narrow, explicit single-command CLI recording payload. Literal data must be trusted and non-secret. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = join(dirname(fileURLToPath(import.meta.url)), 'toad-exec.mjs');
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const text = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0');
/** The first invalid structural path, without any literal values. */
export function cliPayloadIssue(p) {
  if (!keys(p, ['program', 'args', 'expect'])) return [];
  if (!text(p.program) || !p.program.length || p.program.startsWith('-')) return ['program'];
  if (!Array.isArray(p.args) || p.args.length > 100) return ['args'];
  const arg = p.args.findIndex(v => !text(v));
  if (arg >= 0) return ['args', arg];
  if (!keys(p.expect, ['exitCode', 'stdout'])) return ['expect'];
  if (!Number.isInteger(p.expect.exitCode) || p.expect.exitCode < 0 || p.expect.exitCode > 255) return ['expect', 'exitCode'];
  if (!(keys(p.expect.stdout, ['equals']) && text(p.expect.stdout.equals) || keys(p.expect.stdout, ['contains']) && text(p.expect.stdout.contains) && p.expect.stdout.contains.length)) return ['expect', 'stdout'];
  return null;
}
export function validCliPayload(p) { return cliPayloadIssue(p) === null; }

/** One POSIX shell command: the program and every argument is a separately quoted word. */
export function cliCommand(p) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return ['exec', p.program, ...p.args].map((part, i) => i === 0 ? part : quote(part)).join(' ');
}

/** The same command for a person to read: words quoted only when they need it. */
export function cliDisplay(p) {
  const plain = /^[A-Za-z0-9_@%+=:,./-]+$/;
  return [p.program, ...p.args].map(value => plain.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

/** The assertion a person reads in the run viewer, validated again at finalization. */
export function cliAssertion(p) {
  return `exit ${p.expect.exitCode}; stdout ${JSON.stringify(p.expect.stdout)}`;
}

// The finalizer rejects a candidate whose envelope exceeds 64 KiB or whose
// displayed action or assertion exceeds 4096 characters. A 16 KiB candidate
// leaves room for the envelope's ids and hashes, so bounds are checked here.
export const MAX_CANDIDATE_BYTES = 16 * 1024;
export const MAX_STEP_CHARS = 4096;
export function candidateFits(p, scenarioName) {
  return Buffer.byteLength(JSON.stringify({ version: 1, scenarioName, payload: p }) + '\n', 'utf8') <= MAX_CANDIDATE_BYTES &&
    cliDisplay(p).length <= MAX_STEP_CHARS && cliAssertion(p).length <= MAX_STEP_CHARS;
}

/** The assertion in a payload against an observed exit code and stdout. */
export function cliChecks(p, exitCode, stdout) {
  return {
    exitCode: exitCode === p.expect.exitCode,
    stdout: Object.hasOwn(p.expect.stdout, 'equals') ? stdout === p.expect.stdout.equals : stdout.includes(p.expect.stdout.contains),
  };
}

/**
 * Run a recorded CLI payload in a fresh scenario workspace and check it.
 * Deterministic: no model, and the recording itself is the assertion. Replay is
 * credential-free by construction, so the workload gets an empty secret store.
 * An inherited setup workspace, PATH addition or capture switch is not part of
 * the recording, so replay drops them; an explicit sandbox choice is kept.
 */
export function replayCliPayload(payload, { project, receipts, name = '01-replay', env = process.env }) {
  if (!validCliPayload(payload)) throw new Error('Invalid CLI recording payload');
  if (typeof project !== 'string' || !project || typeof receipts !== 'string' || !receipts) throw new Error('Replay needs a project and a receipts folder');
  const replayEnv = { ...env };
  for (const key of ['TOAD_BASE_SCENARIO', 'TOAD_CLI_PATH', 'TOAD_CLI_SECRETS_FILE', 'TOAD_EXEC_JSON', 'TOAD_RECORDING_ENABLED']) delete replayEnv[key];
  const prepared = spawnSync(process.execPath, [runner, 'prepare', project], { encoding: 'utf8', env: replayEnv, timeout: 120000 });
  const scenario = /Scenario ID: (.+)/.exec(prepared.stdout ?? '')?.[1];
  if (prepared.status !== 0 || !scenario) throw new Error(`Replay could not prepare a workspace: ${(prepared.stderr || '').trim() || 'unknown error'}`);
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'toad-replay-'));
    const secrets = join(dir, 'empty.json');
    writeFileSync(secrets, '{}', { mode: 0o600 });
    const result = spawnSync(process.execPath, [runner, 'run', receipts, name, scenario, cliCommand(payload)], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env: { ...replayEnv, TOAD_CLI_SECRETS_FILE: secrets, TOAD_EXEC_JSON: '1', TOAD_EXECUTION_KIND: replayEnv.TOAD_EXECUTION_KIND === 'api' ? 'api' : 'cli', TOAD_EXECUTION_EXPECT: replayEnv.TOAD_EXECUTION_KIND === 'api' ? replayEnv.TOAD_EXECUTION_EXPECT : JSON.stringify(payload.expect) },
    });
    let run;
    try { run = JSON.parse(result.stdout); } catch { throw new Error('The replayer returned no result'); }
    if (run.executionOutcome !== 'FAIL' && (run.executionOutcome === 'ERROR' || run.evidenceError || run.infrastructureError || run.timedOut || run.interrupted || run.outputTruncated || !Number.isInteger(run.exitCode) || typeof run.stdout !== 'string')) throw new Error('The replay did not run cleanly');
    const checks = cliChecks(payload, run.exitCode, run.stdout);
    return { result: run.executionOutcome === 'FAIL' ? 'FAIL' : checks.exitCode && checks.stdout ? 'PASS' : 'FAIL', checks, actual: { exitCode: run.exitCode, stdout: run.stdout }, receipt: run.receipt };
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

/** Asynchronous production replay; cancellation reaches the scenario runner. */
export async function replayCliPayloadAsync(payload, { project, receipts, name = '01-replay', env = process.env, signal }) {
  if (!validCliPayload(payload)) throw new Error('Invalid CLI recording payload');
  if (!project || !receipts) throw new Error('Replay needs a project and receipts');
  const replayEnv = { ...env };
  for (const key of ['TOAD_BASE_SCENARIO', 'TOAD_CLI_PATH', 'TOAD_CLI_SECRETS_FILE', 'TOAD_EXEC_JSON', 'TOAD_RECORDING_ENABLED']) delete replayEnv[key];
  const execute = (args, childEnv) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Replay cancelled or timed out'));
    const child = spawn(process.execPath, [runner, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const stop = () => { child.kill('SIGTERM'); };
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => { if (stdout.length + data.length > 8 * 1024 * 1024) { overflow = true; stop(); } else stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 65536) stderr += data; });
    child.on('error', error => { signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted || overflow) reject(new Error('Replay cancelled, timed out or output too large'));
      else resolve({ status: code, stdout, stderr });
    });
  });
  const prepared = await execute(['prepare', project], replayEnv);
  const scenario = /Scenario ID: (.+)/.exec(prepared.stdout)?.[1];
  if (prepared.status !== 0 || !scenario) throw new Error('Replay could not prepare a workspace');
  const dir = mkdtempSync(join(tmpdir(), 'toad-replay-'));
  try {
    const secrets = join(dir, 'empty.json');
    writeFileSync(secrets, '{}', { mode: 0o600 });
    const result = await execute(['run', receipts, name, scenario, cliCommand(payload)], { ...replayEnv, TOAD_CLI_SECRETS_FILE: secrets, TOAD_EXEC_JSON: '1', TOAD_EXECUTION_KIND: replayEnv.TOAD_EXECUTION_KIND === 'api' ? 'api' : 'cli', TOAD_EXECUTION_EXPECT: replayEnv.TOAD_EXECUTION_KIND === 'api' ? replayEnv.TOAD_EXECUTION_EXPECT : JSON.stringify(payload.expect) });
    const run = JSON.parse(result.stdout);
    if (run.executionOutcome !== 'FAIL' && (result.status !== 0 || run.executionOutcome === 'ERROR' || run.evidenceError || run.infrastructureError || run.timedOut || run.interrupted || run.outputTruncated || !Number.isInteger(run.exitCode) || typeof run.stdout !== 'string')) throw new Error('The replay did not run cleanly');
    const checks = cliChecks(payload, run.exitCode, run.stdout);
    return { result: run.executionOutcome === 'FAIL' ? 'FAIL' : checks.exitCode && checks.stdout ? 'PASS' : 'FAIL', checks, actual: { exitCode: run.exitCode, stdout: run.stdout }, receipt: run.receipt };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
