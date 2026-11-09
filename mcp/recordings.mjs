/** Run-local recording identity, capture status and finalization.
 * Receipts and a PASS alone are not recordings: only a built-in codec that
 * validates a producer's payload can finalize one, and anything else is
 * reported as not captured.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliChecks, cliCommand } from '../agent/tools/toad-cli-recording.mjs';
import { RECORDING_CODECS } from './recording-codecs.mjs';
import { apiCliPayload } from '../agent/tools/toad-api-recording.mjs';

const REASONS = new Set(['unsupported', 'incomplete', 'unsafe']);
const KINDS = new Set(['cli', 'api', 'web']);
const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/** Canonical JSON array, UTF-8 SHA-256, preserving steps and expected exactly. */
export function intentHash(kind, scenario) {
  if (!KINDS.has(kind) || typeof scenario?.steps !== 'string' || typeof scenario?.expected !== 'string') throw new Error('Invalid recording intent');
  return hash([kind, scenario.steps, scenario.expected]);
}

/** Match result names as Toad does, without mapping distinct names to a slug. */
export function scenarioId(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Invalid scenario name');
  return hash(['scenario', name.trim().toLowerCase()]);
}

function recordingDir(run, create = false) {
  const realRun = realpathSync(run);
  if (!lstatSync(realRun).isDirectory()) throw new Error('Invalid run directory');
  const dir = join(realRun, 'recording');
  if (create) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new Error('Unsafe recording directory');
  return dir;
}

function publish(dir, id, value) {
  const path = join(dir, `${id}.json`);
  const temp = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    linkSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readJsonFile(path, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid recording metadata');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

function readReceipt(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    // The runner caps each stream at 2 MiB; anything larger is not its receipt.
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid receipt');
    return readFileSync(fd, 'utf8');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Bind a candidate payload to the receipt it claims to record: the same
 * quoted command, the expected exit, and stdout that satisfies the assertion.
 * Section markers must be unambiguous, so output that contains them is not
 * recorded rather than risk reading the wrong section.
 */
export function receiptProvesPass(receipt, payload) {
  const occurrences = (text, needle) => text.split(needle).length - 1;
  if (typeof receipt !== 'string' || !receipt.startsWith(`$ ${cliCommand(payload)}\n`)) return false;
  if (occurrences(receipt, '\n--- stdout ---\n') !== 1 || occurrences(receipt, '\n--- stderr ---\n') !== 1) return false;
  if (occurrences(receipt, '\nresult: exit ') !== 1 || !receipt.includes(`\nresult: exit ${payload.expect.exitCode}\n`)) return false;
  const stdoutHeader = '\n--- stdout ---\n', stderrHeader = '\n--- stderr ---\n';
  const stdoutAt = receipt.indexOf(stdoutHeader), stderrAt = receipt.indexOf(stderrHeader);
  if (stdoutAt < 0 || stderrAt < stdoutAt) return false;
  if (receipt.includes('\noutput: truncated (2 MiB per stream limit)\n')) return false;
  return cliChecks(payload, payload.expect.exitCode, receipt.slice(stdoutAt + stdoutHeader.length, stderrAt)).stdout;
}

// Require a unique scenario and PASS result from the completed persisted run,
// never a caller-provided PASS or a matching-looking receipt.
function completedScenario(run, kind, scenario) {
  const handoff = readJsonFile(join(run, 'handoff.yaml'), 1024 * 1024);
  const state = readJsonFile(join(run, 'state.json'), 1024 * 1024);
  if (handoff.kind !== kind || state.state !== 'finished' || state.status !== 'ok' || state.cleanup === 'incomplete') throw new Error('Run is not complete');
  const id = scenarioId(scenario.name);
  const requested = (handoff.request?.scenarios ?? []).filter(s => scenarioId(s.name) === id);
  const results = (state.scenarios ?? []).filter(s => scenarioId(s.name) === id);
  if (requested.length !== 1 || results.length !== 1 || results[0].result !== 'PASS' || results[0].missing || intentHash(kind, requested[0]) !== intentHash(kind, scenario)) throw new Error('Scenario is not a matching PASS');
  return { handoff, scenario: requested[0] };
}

/**
 * Check a recording envelope for `scenario` under the handoff in `context`
 * ({ handoff, scenario }) and return its readable steps. The run-local store
 * and saved suites share it; neither trusts a file without it.
 */
export function describeRecording(value, kind, scenario, context) {
  if (!value || Object.keys(value).sort().join(',') !== 'codec,intentHash,kind,payload,scenarioId,status,version' || value.version !== 1 || value.status !== 'recorded' || value.kind !== kind || value.scenarioId !== scenarioId(scenario.name) || value.intentHash !== intentHash(kind, scenario)) throw new Error('Invalid recording envelope');
  const codec = typeof value.codec === 'string' && Object.hasOwn(RECORDING_CODECS, value.codec) && RECORDING_CODECS[value.codec];
  if (!codec || codec.validate(value.payload, context) !== true) throw new Error('Unsupported or unsafe recording');
  const steps = codec.describe(value.payload, context);
  if (!Array.isArray(steps) || !steps.length || steps.length > 100 || steps.some(s => !s || Object.keys(s).sort().join(',') !== 'action,assertion' || typeof s.action !== 'string' || typeof s.assertion !== 'string' || !s.action || !s.assertion || s.action.length > 4096 || s.assertion.length > 4096)) throw new Error('Invalid recording description');
  return steps;
}

/** A recording, status or run metadata file: a small regular file, never through a symlink. */
export function readRecordingFile(path, limit = 65536) { return readJsonFile(path, limit); }

function checkedRecording(run, kind, scenario, value) {
  return describeRecording(value, kind, scenario, completedScenario(run, kind, scenario));
}

/** Finalize only codecs compiled into Toad, after the persisted scenario passed. */
export function finalizeRecording(run, kind, scenario, codec, payload) {
  const value = { version: 1, status: 'recorded', kind, scenarioId: scenarioId(scenario.name), intentHash: intentHash(kind, scenario), codec, payload };
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') + 1 > 65536) throw new Error('Recording is too large');
  // Validate the exact JSON representation to be persisted, not a mutable input.
  const copy = JSON.parse(encoded);
  checkedRecording(run, kind, scenario, copy);
  publish(recordingDir(run, true), copy.scenarioId, copy);
}

/** Finalize only an unambiguous, single structured command for a passing scenario. */
export function finalizeCliCandidates(run, handoff, scenarios) {
  if (!['cli', 'api'].includes(handoff?.kind) || Object.keys(handoff.credentials ?? {}).length || handoff.allow_installs || handoff.target?.setup?.length || handoff.target?.path?.length) return;
  const requests = handoff.request?.scenarios ?? [];
  const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const scenario of requests) {
    try {
      if (scenarios.filter(s => scenarioId(s.name) === scenarioId(scenario.name) && s.result === 'PASS').length !== 1) continue;
      const folder = slug(scenario.name);
      if (!folder || requests.filter(s => slug(s.name) === folder).length !== 1) continue;
      const dir = join(run, 'receipts', folder);
      if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) continue;
      const files = readdirSync(dir);
      if (files.length !== 2) continue;
      const candidates = files.filter(f => /^[a-z0-9][a-z0-9-]*\.txt\.recording\.json$/.test(f));
      if (candidates.length !== 1 || !files.includes(candidates[0].slice(0, -'.recording.json'.length))) continue;
      const value = readJsonFile(join(dir, candidates[0]), 65536);
      if (!value || Object.keys(value).sort().join(',') !== 'payload,scenarioName,version' || value.version !== 1 || value.scenarioName !== scenario.name) continue;
      const receipt = readReceipt(join(dir, candidates[0].slice(0, -'.recording.json'.length)));
      const api = handoff.kind === 'api';
      if (!receiptProvesPass(receipt, api ? apiCliPayload(value.payload) : value.payload)) continue;
      finalizeRecording(run, handoff.kind, scenario, api ? 'api-request-v1' : 'cli-command-v1', value.payload);
    } catch { /* Recording must never alter the test verdict. */ }
  }
}

/** Publish one immutable status atomically; first writer wins, even concurrently. */
export function markNotRecordable(run, kind, scenario, reason) {
  if (!REASONS.has(reason)) throw new Error('Invalid not-recordable reason');
  const id = scenarioId(scenario?.name);
  const intent = intentHash(kind, scenario);
  const dir = recordingDir(run, true);
  publish(dir, id, { version: 1, status: 'not-recordable', reason, kind, scenarioId: id, intentHash: intent });
}

/** Read only known, small, regular status files; malformed/stale data is not recorded. */
export function recordingStatus(run, kind, scenario) {
  let id, intent;
  try { id = scenarioId(scenario?.name); intent = intentHash(kind, scenario); }
  catch { return { status: 'not-captured' }; }
  let fd;
  try {
    const dir = recordingDir(run);
    fd = openSync(join(dir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return { status: 'not-captured' };
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (value?.status === 'recorded') return { status: 'recorded', steps: checkedRecording(run, kind, scenario, value) };
    if (!value || Object.keys(value).sort().join(',') !== 'intentHash,kind,reason,scenarioId,status,version' ||
        value.version !== 1 || value.status !== 'not-recordable' || !REASONS.has(value.reason) ||
        value.kind !== kind || value.scenarioId !== id || value.intentHash !== intent) return { status: 'not-captured' };
    return { status: 'not-recordable', reason: value.reason };
  } catch { return { status: 'not-captured' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
