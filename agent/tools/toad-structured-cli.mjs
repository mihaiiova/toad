#!/usr/bin/env node
/** Run one explicit, non-secret CLI assertion through Toad's existing scenario runner. */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateFits, cliChecks, cliCommand, validCliPayload } from './toad-cli-recording.mjs';

const runner = join(dirname(fileURLToPath(import.meta.url)), 'toad-exec.mjs');
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const string = value => typeof value === 'string' && !value.includes('\0');
const reply = (result, code) => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = code; };

let request;
try {
  if (process.argv.length > 3) throw new Error('invalid arguments');
  const input = readFileSync(process.argv[2] ?? 0);
  if (input.length > 65536) throw new Error('request too large');
  request = JSON.parse(input.toString('utf8'));
  const capture = Object.hasOwn(request, 'capture');
  if (!exactKeys(request, capture ? ['scenario', 'receipts', 'name', 'program', 'args', 'expect', 'capture'] : ['scenario', 'receipts', 'name', 'program', 'args', 'expect']) ||
      (capture && (!exactKeys(request.capture, ['scenarioName', 'complete']) || !string(request.capture.scenarioName) || !request.capture.scenarioName.trim() || request.capture.complete !== true)) ||
      !string(request.scenario) || !request.scenario || !string(request.receipts) || !request.receipts ||
      !string(request.name) || !request.name || !string(request.program) || !request.program || request.program.startsWith('-') ||
      !Array.isArray(request.args) || request.args.length > 100 || !request.args.every(string) ||
      !exactKeys(request.expect, ['exitCode', 'stdout']) || !Number.isInteger(request.expect.exitCode) || request.expect.exitCode < 0 || request.expect.exitCode > 255 ||
      !validCliPayload({ program: request.program, args: request.args, expect: request.expect })) throw new Error('invalid request');
  // Project runs supply a selector even with no credentials. Accept only a
  // safely opened, empty object; never forward its contents to the workload.
  if (Object.hasOwn(process.env, 'TOAD_CLI_SECRETS_FILE')) {
    let fd;
    try {
      const path = process.env.TOAD_CLI_SECRETS_FILE;
      if (!path || !path.startsWith('/')) throw new Error();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      const values = JSON.parse(readFileSync(fd, 'utf8'));
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length) throw new Error();
    } catch { throw new Error('credentials are not supported'); }
    finally { if (fd !== undefined) closeSync(fd); }
  } else {
    // Only legacy runs use the shared store; project runs never fall back to it.
    try {
      if (statSync(join(process.cwd(), '.faur', 'test-secrets.env')).size) throw new Error('credentials are not supported');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
} catch (error) {
  reply({ status: 'error', error: error.message === 'credentials are not supported' ? error.message : 'invalid structured CLI request' }, 2);
}

if (request && !process.exitCode) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'toad-structured-cli-'));
    const secrets = join(dir, 'empty.json');
    writeFileSync(secrets, '{}', { mode: 0o600 });
    // Every argument is a separately quoted POSIX shell word. No interpolation.
    const command = cliCommand({ program: request.program, args: request.args });
    const result = spawnSync(process.execPath, [runner, 'run', request.receipts, request.name, request.scenario, command], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TOAD_CLI_SECRETS_FILE: secrets, TOAD_EXEC_JSON: '1' },
    });
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw new Error('scenario runner failed');
    let run;
    try { run = JSON.parse(result.stdout); } catch { throw new Error('invalid scenario runner result'); }
    if (result.status !== 0 || run.infrastructureError || run.timedOut || run.interrupted || run.outputTruncated || !Number.isInteger(run.exitCode) || typeof run.stdout !== 'string' || typeof run.receipt !== 'string') {
      reply({ status: 'error', error: 'scenario runner did not complete reliably', ...(typeof run.receipt === 'string' ? { receipt: run.receipt } : {}) }, 2);
    } else {
    const { exitCode, stdout } = cliChecks(request, run.exitCode, run.stdout);
    const payload = { program: request.program, args: request.args, expect: request.expect };
    let captured = false;
    // Captured means a candidate was written beside the receipt. The run
    // finalizes it later, and only if the scenario passed and the receipt matches.
    if (exitCode && stdout && request.capture && process.env.TOAD_RECORDING_ENABLED === 'cli-v1' && candidateFits(payload, request.capture.scenarioName)) {
      try {
        writeFileSync(`${run.receipt}.recording.json`, JSON.stringify({ version: 1, scenarioName: request.capture.scenarioName, payload }) + '\n', { flag: 'wx', mode: 0o600 });
        captured = true;
      } catch { /* Capture is optional and must not change the test verdict. */ }
    }
    reply({ status: exitCode && stdout ? 'pass' : 'fail', checks: { exitCode, stdout }, actual: { exitCode: run.exitCode, stdout: run.stdout }, receipt: run.receipt, ...(request.capture ? { captured } : {}) }, exitCode && stdout ? 0 : 1);
    }
  } catch (error) {
    reply({ status: 'error', error: error.message }, 2);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
