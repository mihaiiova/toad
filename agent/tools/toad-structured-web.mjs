#!/usr/bin/env node
/**
 * Run one bounded, credential-free web scenario (navigation, clicks, fills
 * and explicit assertions with stable locators) in a fresh, isolated browser,
 * and record it as a receipt. With capture, a passing run leaves a candidate
 * beside the receipt; the run finalizes it only if the scenario PASSes.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindWebTarget, runWebPayload, validWebPayload, webCandidateFits, webReceipt } from './toad-web-recording.mjs';

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const reply = (result, code) => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = code; };
class Refused extends Error {}

/** No secrets may reach a recorded scenario: the per-run store must be empty. */
function assertNoSecrets() {
  const selected = process.env.TOAD_PLAYWRIGHT_SECRETS_FILE;
  if (Object.hasOwn(process.env, 'TOAD_PLAYWRIGHT_SECRETS_FILE')) {
    let fd;
    try {
      if (!selected || !isAbsolute(selected)) throw new Error();
      fd = openSync(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      if (readFileSync(fd, 'utf8').trim()) throw new Error();
    } catch { throw new Refused('credentials are not supported'); }
    finally { if (fd !== undefined) closeSync(fd); }
    return;
  }
  // Only legacy runs use the agent's shared store; project runs never fall back to it.
  try { if (statSync(join(agentRoot, '.faur', 'test-secrets.env')).size) throw new Refused('credentials are not supported'); }
  catch (error) { if (error instanceof Refused) throw error; if (error.code !== 'ENOENT') throw new Refused('credentials are not supported'); }
}

let request, receiptsDir;
try {
  if (process.argv.length > 3) throw new Error();
  const raw = readFileSync(process.argv[2] ?? 0);
  if (raw.length > 65536) throw new Error();
  request = JSON.parse(raw.toString('utf8'));
  const capture = request && Object.hasOwn(request, 'capture');
  if (!exactKeys(request, ['receipts', 'name', 'payload', ...(capture ? ['capture'] : [])]) ||
      typeof request.receipts !== 'string' || !request.receipts || request.receipts.includes('\0') ||
      typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.name) ||
      (capture && (!exactKeys(request.capture, ['scenarioName', 'complete']) || typeof request.capture.scenarioName !== 'string' || !request.capture.scenarioName.trim() || request.capture.complete !== true))) throw new Error();
  if (Object.hasOwn(process.env, 'TOAD_WEB_TARGET_URL')) {
    try { request.payload = bindWebTarget(request.payload, process.env.TOAD_WEB_TARGET_URL); }
    catch { throw new Refused('navigation is outside the effective run target'); }
  }
  if (!validWebPayload(request.payload)) throw new Refused('unsupported web scenario: use 2-30 steps (goto first, an assertion last) with role/label/text locators and non-secret literals; sign-in, password, token and similar fields are not supported');
  const allowed = process.env.TOAD_RECEIPTS_DIR;
  if (allowed !== undefined && !isAbsolute(allowed)) throw new Error();
  const root = allowed ? resolve(allowed) : join(agentRoot, 'data', 'receipts');
  receiptsDir = resolve(process.cwd(), request.receipts);
  if (receiptsDir !== root && !receiptsDir.startsWith(root + sep)) throw new Refused(`the receipts folder must be inside ${root}`);
  assertNoSecrets();
} catch (error) {
  request = undefined;
  reply({ status: 'error', error: error instanceof Refused ? error.message : 'invalid structured web request' }, 2);
}

if (request) {
  try {
    const receipt = join(receiptsDir, `${request.name}.txt`);
    try { statSync(receipt); throw Object.assign(new Error(), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(receiptsDir, { recursive: true });
    const outcome = await runWebPayload(request.payload, { targetUrl: process.env.TOAD_WEB_TARGET_URL, screenshot: join(receiptsDir, `${request.name}.png`) });
    // A receipt is never overwritten: a later run cannot replace a passing one.
    writeFileSync(receipt, webReceipt(request.payload, outcome), { flag: 'wx', mode: 0o600 });
    const status = outcome.result === 'PASS' ? 'pass' : outcome.result === 'FAIL' ? 'fail' : 'error';
    let captured = false;
    if (status === 'pass' && request.capture && process.env.TOAD_RECORDING_ENABLED === 'web-v1' && webCandidateFits(request.payload, request.capture.scenarioName)) {
      try {
        writeFileSync(`${receipt}.recording.json`, JSON.stringify({ version: 1, scenarioName: request.capture.scenarioName, payload: request.payload }) + '\n', { flag: 'wx', mode: 0o600 });
        captured = true;
      } catch { /* Capture is optional and never changes the result. */ }
    }
    reply({
      status, result: outcome.result, ...(Number.isInteger(outcome.step) ? { step: outcome.step + 1 } : {}), ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.result === 'UNSAFE' ? { error: 'credential-like field: not supported' } : {}), receipt, ...(request.capture ? { captured } : {}),
    }, status === 'pass' ? 0 : status === 'fail' ? 1 : 2);
  } catch (error) {
    reply({ status: 'error', error: error.code === 'EEXIST' ? 'a receipt with this name already exists; use a new name' : 'the web scenario could not be recorded' }, 2);
  }
}
