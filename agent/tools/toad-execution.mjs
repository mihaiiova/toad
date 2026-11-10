/** Run-local operation and assertion evidence. Independent atomic records, never receipt-folder metadata. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const MAX_BYTES = 128 * 1024;
const UUID = /^[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;
const outcomes = ['running', 'completed', 'PASS', 'FAIL', 'ERROR', 'cancelled'];
const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const executionScenarioId = name => createHash('sha256').update(JSON.stringify(['scenario', name.trim().toLowerCase()])).digest('hex');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const relative = value => str(value, 1024) && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(p => p && p !== '.' && p !== '..');
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === allowed.slice().sort().join(',');
const assertion = v => v === null || (keys(v, ['kind', 'result']) && ['expectVisible', 'expectText', 'expectUrl', 'exitCode', 'stdout', 'httpStatus', 'body', 'agentAttestation'].includes(v.kind) && ['PASS', 'FAIL', 'ERROR'].includes(v.result));

// v1 web records remain readable unchanged. v2 CLI/API adds explicit verification
// provenance; null means operation-only, never implicit scenario completion.
// v3 is exclusively hook-phase infrastructure, with no product assertions/verification.
function validVerification(v) {
  const verification = v.verification;
  if (verification === null) return true;
  if (!keys(verification, ['source', 'executionIds']) || !Array.isArray(verification.executionIds) || verification.executionIds.length > 9 || !verification.executionIds.every(id => UUID.test(id))) return false;
  if (verification.source === 'machine') return verification.executionIds.length === 0 && Array.isArray(v.steps) && v.steps.length > 0 && v.steps.every(s => s.assertion && s.assertion.kind !== 'agentAttestation');
  return verification.source === 'agent' && verification.executionIds.length > 0 && v.assertion?.kind === 'agentAttestation';
}

export function validateExecutionRecord(v) {
  return !!(keys(v, ['version', 'kind', 'id', 'sessionId', 'attemptId', 'sequence', 'scenarioId', 'scenarioName', 'scenarioSource', 'mode', 'operation', 'startedAt', 'finishedAt', 'outcome', 'assertion', 'steps', 'artifacts', 'captures', 'evidenceComplete', ...([2, 3].includes(v?.version) ? ['verification'] : []), ...(v?.version === 3 ? ['phase'] : [])]) &&
    (v.version === 3 && ['running', 'completed', 'ERROR', 'cancelled'].includes(v.outcome) && ['web', 'cli', 'api'].includes(v.kind) && ['before', 'after'].includes(v.phase) && v.operation === (v.phase === 'before' ? 'beforeAttempt' : 'afterAttempt') && v.verification === null && v.assertion === null && Array.isArray(v.steps) && v.steps.length === 0 || v.version === 1 && v.kind === 'web' || v.version === 2 && ['cli', 'api'].includes(v.kind) && validVerification(v)) && UUID.test(v.id) && UUID.test(v.sessionId) && UUID.test(v.attemptId) &&
    Number.isSafeInteger(v.sequence) && v.sequence > 0 && HASH.test(v.scenarioId) && str(v.scenarioName, 500) && v.scenarioName.trim() && v.scenarioId === executionScenarioId(v.scenarioName) &&
    ['declared', 'derived'].includes(v.scenarioSource) && ['agent', 'replay'].includes(v.mode) &&
    str(v.operation, 100) && /^[a-zA-Z_]+$/.test(v.operation) && time(v.startedAt) &&
    (v.finishedAt === null || time(v.finishedAt) && Date.parse(v.finishedAt) >= Date.parse(v.startedAt)) && outcomes.includes(v.outcome) &&
    (v.outcome === 'running' ? v.finishedAt === null : v.finishedAt !== null) && assertion(v.assertion) &&
    Array.isArray(v.steps) && v.steps.length <= 30 && v.steps.every((s, i) => keys(s, ['index', 'operation', 'startedAt', 'finishedAt', 'outcome', 'assertion']) && s.index === i + 1 && str(s.operation, 80) && /^[a-zA-Z]+$/.test(s.operation) && time(s.startedAt) && time(s.finishedAt) && Date.parse(s.finishedAt) >= Date.parse(s.startedAt) && outcomes.includes(s.outcome) && s.outcome !== 'running' && assertion(s.assertion)) &&
    Array.isArray(v.artifacts) && v.artifacts.length <= 10 && v.artifacts.every(a => keys(a, ['kind', 'path']) && ['receipt', 'screenshot', 'hierarchy', 'console'].includes(a.kind) && relative(a.path)) &&
    Array.isArray(v.captures) && v.captures.length <= 10 && v.captures.every(c => keys(c, ['kind', 'status']) && ['screenshot', 'hierarchy', 'console'].includes(c.kind) && ['saved', 'unavailable', 'error'].includes(c.status)) &&
    typeof v.evidenceComplete === 'boolean' && (!v.evidenceComplete || v.artifacts.some(a => a.kind === 'receipt')) && Buffer.byteLength(JSON.stringify(v)) <= MAX_BYTES);
}

/** All path components are regular directories/files, not just the final component. */
export function executionArtifactPath(run, rel, output = false) {
  if (!relative(rel) || !['receipts', 'execution-artifacts'].includes(rel.split('/')[0])) throw new Error('Invalid evidence path');
  const root = resolve(run);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Invalid run');
  let current = root;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = lstatSync(current); } catch (error) { if (output && i === parts.length - 1 && error.code === 'ENOENT') return current; throw error; }
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) throw new Error('Invalid evidence path');
  }
  return current;
}

function recordDir(run) {
  const root = resolve(run);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Invalid run');
  const dir = join(root, 'executions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Invalid execution directory');
  return dir;
}
function readSafe(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error('Invalid record');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readExecutionRecords(run) {
  const records = [], errors = [];
  const root = resolve(run), dir = join(root, 'executions');
  try { if (lstatSync(join(root, 'execution-error.txt')).isFile()) errors.push('Required execution evidence could not be saved or bound'); } catch {}
  try {
    if (realpathSync(root) !== root || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error();
    const files = readdirSync(dir).sort();
    if (files.length > 10000) errors.push('Execution record limit exceeded');
    for (const file of files.slice(0, 10000)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      try {
        const v = readSafe(join(dir, file));
        if (!validateExecutionRecord(v) || file !== `${v.id}.json`) throw new Error();
        v.artifacts = v.artifacts.filter(a => {
          try { executionArtifactPath(root, a.path); return true; }
          catch {
            if (a.kind === 'receipt') {
              v.evidenceComplete = false;
              errors.push('Required execution receipt is unavailable');
              return false;
            }
            // Losing an optional diagnostic must not invalidate a saved assertion.
            const capture = v.captures.find(c => c.kind === a.kind);
            if (capture) capture.status = 'error';
            else v.captures.push({ kind: a.kind, status: 'error' });
            return false;
          }
        });
        records.push(v);
      } catch { errors.push('An execution record or its evidence is unavailable'); }
    }
  } catch (error) { if (error.code !== 'ENOENT') errors.push('Execution records are unavailable'); }
  for (const record of records) {
    if (record.verification?.source !== 'agent') continue;
    if (record.verification.executionIds.some(id => !records.some(r => r.id === id && r.kind === record.kind && r.scenarioId === record.scenarioId && r.evidenceComplete && r.finishedAt && ['completed', 'PASS', 'FAIL', 'ERROR', 'cancelled'].includes(r.outcome)))) {
      record.evidenceComplete = false; errors.push('Attested execution evidence is unavailable');
    }
  }
  return { available: records.length > 0, records: records.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence || a.id.localeCompare(b.id)), errors };
}

export function noteExecutionError(run) {
  try { writeFileSync(join(run, 'execution-error.txt'), 'Required execution evidence could not be saved or bound.\n', { flag: 'wx', mode: 0o600 }); } catch { /* The tool also returns an explicit ERROR. */ }
}

export function executionContext(env, scenarioName) {
  if (!env.TOAD_EXECUTION_RUN_DIR) return null;
  if (!str(scenarioName, 500) || !scenarioName.trim()) throw new Error('Bind an exact scenario name before testing');
  const names = JSON.parse(env.TOAD_EXECUTION_SCENARIOS ?? '[]');
  if (!Array.isArray(names) || names.some(n => !str(n, 500)) || names.length && !names.includes(scenarioName)) throw new Error('Unknown scenario name; use an exact declared name');
  return { run: env.TOAD_EXECUTION_RUN_DIR, scenarioName, scenarioSource: names.length ? 'declared' : 'derived', kind: ['cli', 'api'].includes(env.TOAD_EXECUTION_KIND) ? env.TOAD_EXECUTION_KIND : 'web', mode: env.TOAD_EXECUTION_MODE === 'replay' ? 'replay' : 'agent', ...(env.TOAD_EXECUTION_PHASE ? { phase: env.TOAD_EXECUTION_PHASE } : {}), ...(env.TOAD_ATTEMPT_ID ? { sequence: Math.max(0, ...readExecutionRecords(env.TOAD_EXECUTION_RUN_DIR).records.filter(r => r.attemptId === env.TOAD_ATTEMPT_ID).map(r => r.sequence)) } : {}), sessionId: env.TOAD_ATTEMPT_ID ?? randomUUID(), attemptId: env.TOAD_ATTEMPT_ID ?? randomUUID() };
}

export function beginExecution(context, operation) {
  if (!context) return null;
  const record = { version: context.phase ? 3 : context.kind === 'web' || !context.kind ? 1 : 2, kind: context.kind ?? 'web', ...(context.phase ? { phase: context.phase } : {}), ...(context.phase || context.kind && context.kind !== 'web' ? { verification: null } : {}), id: randomUUID(), sessionId: context.sessionId, attemptId: context.attemptId,
    scenarioId: executionScenarioId(context.scenarioName), scenarioName: context.scenarioName, scenarioSource: context.scenarioSource,
    mode: context.mode, sequence: context.sequence = (context.sequence ?? 0) + 1, operation, startedAt: new Date().toISOString(), finishedAt: null, outcome: 'running', assertion: null,
    steps: [], artifacts: [], captures: [], evidenceComplete: false };
  saveExecution(context.run, record);
  return { run: context.run, record };
}

function saveExecution(run, record) {
  if (!validateExecutionRecord(record)) throw new Error('Invalid execution record');
  const dir = recordDir(run), target = join(dir, `${record.id}.json`), tmp = join(dir, `${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
  } finally { try { unlinkSync(tmp); } catch {} }
}
export function finishExecution(handle, fields) {
  if (!handle) return;
  Object.assign(handle.record, fields, { finishedAt: new Date().toISOString() });
  saveExecution(handle.run, handle.record);
}

export function executionOutputPath(run, file) {
  if (!resolve(file).startsWith(resolve(run) + sep)) throw new Error('Invalid evidence path');
  return executionArtifactPath(run, resolve(file).slice(resolve(run).length + 1).split(sep).join('/'), true);
}

export function artifactReference(run, file, kind) {
  const path = resolve(file).slice(resolve(run).length + 1).split(sep).join('/');
  if (!resolve(file).startsWith(resolve(run) + sep)) throw new Error('Invalid evidence path');
  executionArtifactPath(run, path);
  return { kind, path };
}

/** Mandatory operation receipt contains no tool arguments, response text or secrets. */
export function operationReceipt(handle, outcome) {
  const dir = join(handle.run, 'execution-artifacts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('Invalid evidence directory');
  const path = join(dir, `${handle.record.id}.txt`);
  executionOutputPath(handle.run, path);
  writeFileSync(path, `${handle.record.kind} operation: ${handle.record.operation}\nexecution: ${handle.record.id}\noutcome: ${outcome}\nThis is tool operation evidence, not a scenario assertion.\n`, { flag: 'wx', mode: 0o600 });
  return artifactReference(handle.run, path, 'receipt');
}

/** Host-side typed facts from the existing sandbox runner, never transcript heuristics. */
export function commandAssertions(expect, run, kind = 'cli') {
  if (!expect) return [];
  if (kind === 'api') {
    // The fixed API program emits one JSON response followed by its assertion.
    let response;
    try { response = JSON.parse(run.stdout.split('\n')[0]); } catch { return []; }
    if (!Number.isInteger(response.status) || typeof response.body !== 'string') return [];
    return [{ kind: 'httpStatus', result: response.status === expect.status ? 'PASS' : 'FAIL' },
      { kind: 'body', result: (Object.hasOwn(expect.body, 'equals') ? response.body === expect.body.equals : response.body.includes(expect.body.contains)) ? 'PASS' : 'FAIL' }];
  }
  return [{ kind: 'exitCode', result: run.exitCode === expect.exitCode ? 'PASS' : 'FAIL' },
    { kind: 'stdout', result: run.outputTruncated ? 'ERROR' : (Object.hasOwn(expect.stdout, 'equals') ? run.stdout === expect.stdout.equals : run.stdout.includes(expect.stdout.contains)) ? 'PASS' : 'FAIL' }];
}

/** Explicit exploratory completion, bound to durable operations in this scenario. */
export function attestScenario(env, { scenarioName, result, executionIds }) {
  if (!['PASS', 'FAIL', 'ERROR'].includes(result) || !Array.isArray(executionIds) || !executionIds.length || executionIds.length > 9 || new Set(executionIds).size !== executionIds.length) throw new Error('Invalid attestation');
  const context = executionContext(env, scenarioName);
  if (!context || context.kind === 'web') throw new Error('CLI/API execution context required');
  const evidence = readExecutionRecords(context.run);
  const records = executionIds.map(id => evidence.records.find(r => r.id === id));
  if (records.some(r => !r || r.phase || r.scenarioId !== executionScenarioId(scenarioName) || r.kind !== context.kind || !r.evidenceComplete || !r.finishedAt || r.operation === 'attestScenario')) throw new Error('Attestation requires completed scenario operations');
  if (result === 'PASS' && records.some(r => !['completed', 'PASS'].includes(r.outcome))) throw new Error('Cannot attest PASS over failed or incomplete operations');
  context.sessionId = records.at(-1).sessionId; context.attemptId = records.at(-1).attemptId;
  context.sequence = Math.max(0, ...evidence.records.filter(r => r.attemptId === context.attemptId).map(r => r.sequence));
  const handle = beginExecution(context, 'attestScenario');
  try {
    const artifacts = [operationReceipt(handle, result), ...records.flatMap(r => r.artifacts.filter(a => a.kind === 'receipt'))];
    finishExecution(handle, { outcome: result, assertion: { kind: 'agentAttestation', result }, verification: { source: 'agent', executionIds }, artifacts: artifacts.slice(0, 10), evidenceComplete: true });
    return { executionId: handle.record.id, result, source: 'agent' };
  } catch (error) { noteExecutionError(context.run); throw error; }
}
