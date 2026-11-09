/**
 * Replaying a suite's saved recordings, without a model.
 *
 * `toad run` replays each selected scenario whose saved recording is valid
 * under the suite as it runs today. A replay that passes is the result. A
 * replay whose recorded assertion fails, and a scenario with no usable
 * recording, go to the agent; a replay that could not run (the sandbox or a
 * prerequisite) is an ERROR, never a reason to spend a model call.
 *
 * When the agent passes a scenario and captures a recording that differs
 * from the saved one, that recording is *proposed*: it stays in the run
 * folder, and the saved one is untouched, until `toad suites accept` or
 * `toad run --update-recordings` writes it beside the suite. Nothing here
 * runs git.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readExecutionRecords } from '../agent/tools/toad-execution.mjs';
import { replayCliPayloadAsync } from '../agent/tools/toad-cli-recording.mjs';
import { apiCliPayload, validApiPayload } from '../agent/tools/toad-api-recording.mjs';
import { WEB_CODEC, replayWebPayload, webPayloadUnder } from '../agent/tools/toad-web-recording.mjs';
import { describeRecording, finalizeRecording, intentHash, readRecordingFile, recordingStatus, scenarioId, recordingHash, recordingText, validateRecording } from './recordings.mjs';
import { ensureDirectory, projectFolder, readProjectConfig, readSuites, registerProject, withDefaults } from './projects.mjs';
import { writeState } from './run.mjs';
import { HOOK_RECORDING_REASON } from './attempt-schema.mjs';
import { DefinitionError } from './definition-diagnostics.mjs';
import { recordingUnder, writeRecordingContext } from './recording-context.mjs';
import { SUITE_NAME, effectiveHandoff, inspectSuite, runFolder } from './suite-recordings.mjs';

export const MODES = ['replay', 'agent', 'healed'];
const STALE = { changed: 'the saved recording is stale (steps or expected changed)', unsupported: 'the saved recording is stale (no longer supported by this suite)', invalid: 'the saved recording is not a valid recording', target: 'the saved recording is stale (suite target changed; original target is not replayed)' };

/** The receipts folder name the lead uses for a scenario. */
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

/**
 * `url` with its `from` prefix replaced by `to`, or null when `url` is not
 * under `from`. Only whole path segments match: /v1 is not under /v.
 */
export function rebaseUrl(url, from, to) {
  if (typeof url !== 'string' || typeof from !== 'string' || typeof to !== 'string') return null;
  const base = from.replace(/\/+$/, ''), next = to.replace(/\/+$/, '');
  if (url !== base && !url.startsWith(`${base}/`) && !url.startsWith(`${base}?`)) return null;
  try { new URL(base); new URL(next); } catch { return null; }
  return next + url.slice(base.length);
}

/** An API or web envelope with its URLs moved from one base to another; null if it cannot be. */
function rebasedEnvelope(envelope, from, to) {
  if (!['api-request-v1', WEB_CODEC].includes(envelope.codec) || from === to) return envelope;
  if (!from || !to) return null;
  if (envelope.codec === WEB_CODEC) {
    if (!Array.isArray(envelope.payload?.steps)) return null;
    const steps = envelope.payload.steps.map(s => s?.action === 'goto' ? { ...s, url: rebaseUrl(s.url, from, to) } : s);
    const payload = { ...envelope.payload, steps };
    return steps.every(s => s?.action !== 'goto' || s.url) && webPayloadUnder(payload, to) ? { ...envelope, payload } : null;
  }
  const url = rebaseUrl(envelope.payload?.url, from, to);
  const payload = url && { ...envelope.payload, url };
  return payload && validApiPayload(payload) ? { ...envelope, payload } : null;
}

/** Whether every URL a recording visits is under `base`. */
const recordedUnder = (envelope, base) => envelope.codec === WEB_CODEC
  ? webPayloadUnder(envelope.payload, base)
  : !!rebaseUrl(envelope.payload?.url, base, base);

/**
 * How each scenario will run: { mode: 'replay', envelope } with the payload
 * as it will be replayed (an API URL moved to --url), or { mode: 'agent',
 * reason }. Every choice carries `saved`, the valid saved envelope if any,
 * and `savedSteps`, for comparing what the agent records. Reads only.
 */
export function replayChoices(project, suite, config, scenarios, { replay = true, url } = {}) {
  const inspection = inspectSuite(project, suite, config, { envelopes: true });
  if (inspection.errors.length) throw new DefinitionError(inspection.errors);
  const inspected = inspection.recordings;
  const byName = new Map(suite.scenarios.map((s, i) => [s.name, inspected[i]]));
  const base = effectiveHandoff(suite, config, project).target?.url;
  return scenarios.map(scenario => {
    if (effectiveHandoff(suite, config, project).attempt) return { mode: 'agent', reason: HOOK_RECORDING_REASON };
    const rec = byName.get(scenario.name) ?? { status: 'none' };
    const snapshot = proposalSnapshot(project, suite, config, scenario);
    const saved = { snapshot, ...(rec.status === 'recorded' ? { saved: rec.envelope, savedSteps: rec.steps } : {}) };
    const stale = rec.status === 'stale' ? { stale: rec.reason } : {};
    if (rec.status === 'stale') return { mode: 'agent', reason: STALE[rec.reason] ?? 'the saved recording is stale', ...stale, ...saved };
    if (rec.status !== 'recorded') return { mode: 'agent', reason: 'no saved recording', ...saved };
    if (!replay) return { mode: 'agent', reason: 'replay is off (--no-replay)', ...saved };
    const located = suite.kind === 'api' || suite.kind === 'web';
    if (located && !recordedUnder(rec.envelope, base)) {
      return { mode: 'agent', reason: "the recorded URL is not under the suite's current URL", ...saved };
    }
    if (located && url) {
      const envelope = rebasedEnvelope(rec.envelope, base, url);
      if (!envelope) return { mode: 'agent', reason: "the recorded URL is not under the suite's URL, so --url cannot move it", ...saved };
      return { mode: 'replay', envelope, ...saved };
    }
    return { mode: 'replay', envelope: rec.envelope, ...saved };
  });
}

/**
 * Replay one envelope in a fresh workspace of `workdir`, recording its
 * receipt under `receipts`. PASS or FAIL is the recording's own assertion;
 * ERROR means the replay could not run, and says why.
 */
export async function replayScenario(envelope, { workdir, receipts, name = '01-replay', env, signal, targetUrl, handoff }) {
  if (handoff?.attempt || env?.TOAD_ATTEMPT_ID) return { result: 'ERROR', message: HOOK_RECORDING_REASON };
  const observedFailure = () => env?.TOAD_EXECUTION_RUN_DIR && readExecutionRecords(env.TOAD_EXECUTION_RUN_DIR).records.some(r => r.mode === 'replay' && r.scenarioName === env.TOAD_EXECUTION_SCENARIO_NAME && (r.outcome === 'FAIL' || r.steps.some(s => s.assertion?.result === 'FAIL')));
  try {
    if (envelope.codec === WEB_CODEC) {
      // A fresh, isolated browser with no secrets; the recording is the assertion.
      const outcome = await replayWebPayload(envelope.payload, { receipts, name, env, signal, targetUrl });
      if (outcome.result === 'ERROR') return { result: observedFailure() ? 'FAIL' : 'ERROR', receipt: outcome.receipt, message: `The replay could not run: ${outcome.message ?? 'unknown error'}` };
      return { result: outcome.result, receipt: outcome.receipt, ...(outcome.result === 'FAIL' ? { message: 'The saved recording\'s assertion failed' } : {}) };
    }
    if (!['api-request-v1', 'cli-command-v1'].includes(envelope.codec)) return { result: 'ERROR', message: 'The recording uses an unknown codec' };
    const payload = envelope.codec === 'api-request-v1' ? apiCliPayload(envelope.payload) : envelope.payload;
    const outcome = await replayCliPayloadAsync(payload, { project: workdir, receipts, name, env: { ...env, TOAD_EXECUTION_KIND: envelope.codec === 'api-request-v1' ? 'api' : 'cli', ...(envelope.codec === 'api-request-v1' ? { TOAD_EXECUTION_EXPECT: JSON.stringify(envelope.payload.expect) } : {}) }, signal });
    if ([126, 127].includes(outcome.actual.exitCode) || (envelope.codec === 'api-request-v1' && outcome.actual.exitCode === 2)) throw new Error('Replay infrastructure or prerequisite error');
    return { result: outcome.result, receipt: outcome.receipt, ...(outcome.result === 'FAIL' ? { message: 'The saved recording\'s assertion failed' } : {}) };
  } catch (error) {
    return { result: observedFailure() ? 'FAIL' : 'ERROR', message: `The replay could not run: ${error.message}` };
  }
}

/** The environment a replay runs in: no secrets, the run's receipts, the chosen sandbox and image. */
export function replayEnv(env, { receipts, sandbox, image, executionRun, scenarioName, scenarios = [] }) {
  const out = { ...env, TOAD_RECEIPTS_DIR: receipts };
  for (const key of Object.keys(out)) if (key.startsWith('TOAD_ATTEMPT_')) delete out[key];
  for (const key of ['TOAD_PLAYWRIGHT_SECRETS_FILE', 'TOAD_CLI_SECRETS_FILE', 'TOAD_CLI_PATH', 'TOAD_EXEC_JSON', 'TOAD_RECORDING_ENABLED', 'TOAD_BASE_SCENARIO']) delete out[key];
  for (const key of ['TOAD_EXECUTION_RUN_DIR', 'TOAD_EXECUTION_SCENARIO_NAME', 'TOAD_EXECUTION_SCENARIOS', 'TOAD_EXECUTION_MODE', 'TOAD_EXECUTION_KIND', 'TOAD_EXECUTION_EXPECT', 'TOAD_EXECUTION_PHASE']) delete out[key];
  if (executionRun) Object.assign(out, { TOAD_EXECUTION_RUN_DIR: executionRun, TOAD_EXECUTION_SCENARIO_NAME: scenarioName, TOAD_EXECUTION_SCENARIOS: JSON.stringify(scenarios), TOAD_EXECUTION_MODE: 'replay' });
  if (sandbox) out.TOAD_CLI_SANDBOX = sandbox;
  if (image) out.TOAD_CLI_IMAGE = image;
  return out;
}

/** A run folder for replays, shown in `toad ui` like any other run. */
export function startReplayRun(project, handoff, { sandbox } = {}) {
  const folder = join(project, '.toad');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const run = join(folder, 'runs', id);
  ensureDirectory(run);
  ensureDirectory(join(run, 'receipts'));
  ensureDirectory(join(run, 'reports'));
  writeFileSync(join(run, 'handoff.yaml'), JSON.stringify(handoff, null, 2) + '\n', { mode: 0o600 });
  writeState(run, { state: 'running', origin: 'cli', ...(sandbox ? { sandbox } : {}) });
  try { registerProject(project); } catch { /* the list is a convenience */ }
  return run;
}

/**
 * Finish a replay run: its state, its report, and, for each replay that
 * passed, the replayed recording in the run's own recording folder.
 */
export function finishReplayRun(run, handoff, results, { suite, accept } = {}) {
  const verdict = results.some(r => r.result === 'FAIL') ? 'FAIL' : results.some(r => r.result === 'ERROR') ? 'ERROR' : 'PASS';
  const status = results.some(r => r.result === 'ERROR') ? 'error' : 'ok';
  const scenarios = results.map(r => ({ name: r.scenario.name, result: r.result }));
  const modes = Object.fromEntries(results.map(r => [r.scenario.name, r.result === 'FAIL' ? 'agent' : 'replay']));
  writeState(run, { state: 'finished', finished: new Date().toISOString(), verdict, status, scenarios, replay: { suite, modes, ...(accept ? { accept } : {}) } });
  writeFileSync(join(run, 'reports', 'report.md'), [
    '# Toad run', `Status: ${status}`, `Verdict: ${verdict}`,
    'Replayed the suite\'s saved recordings, without a model.',
    ['Results:', ...results.map(r => `- ${r.result} | ${r.scenario.name}`)].join('\n'),
    ...results.filter(r => r.message).map(r => `${r.scenario.name}: ${r.message}${r.result === 'FAIL' ? '; the agent checks it next.' : ''}`),
  ].join('\n\n') + '\n', { mode: 0o600 });
  for (const r of results) {
    if (r.result !== 'PASS') continue;
    try { finalizeRecording(run, handoff.kind, r.scenario, r.envelope.codec, r.envelope.payload); } catch { /* display only */ }
  }
  return { verdict, status };
}

/** Readable lines for what changed between two recordings' steps. */
export function stepsDiff(previous, next) {
  const line = s => `${s.action} => ${s.assertion}`;
  const before = (previous ?? []).map(line), after = (next ?? []).map(line);
  // Sequence diff, not a set: order and repeated actions/assertions are meaningful.
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) lengths[i][j] = before[i] === after[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const diff = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { i++; j++; }
    else if (i < before.length && (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])) diff.push(`- ${before[i++]}`);
    else diff.push(`+ ${after[j++]}`);
  }
  return diff;
}

const digest = value => createHash('sha256').update(recordingText(value)).digest('hex');

function savedHash(project, suite, id) {
  try { return recordingHash(readRecordingFile(join(project, '.toad', 'suites', `${suite}.recordings`, `${id}.json`))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Includes absent-file state and effective intent/target/restrictions, not secret values. */
export function proposalSnapshot(project, suite, config, scenario) {
  return { version: 1, scenarioId: scenarioId(scenario.name), intentHash: intentHash(suite.kind, scenario),
    contextHash: digest(effectiveHandoff(suite, config, project)), savedHash: savedHash(project, suite.name, scenarioId(scenario.name)) };
}

function checkProposal(project, suite, scenario, envelope, provenance) {
  const folder = projectFolder(project);
  const current = readSuites(folder).find(s => s.name === suite.name);
  const currentScenario = current?.scenarios.find(s => scenarioId(s.name) === scenarioId(scenario.name));
  if (!currentScenario) throw new Error('Suite scenario changed; regenerate and review the proposal.');
  const snapshot = proposalSnapshot(project, current, readProjectConfig(folder), currentScenario);
  if (!provenance || provenance.proposedHash !== recordingHash(envelope) || Object.keys(snapshot).some(k => snapshot[k] !== provenance[k])) throw new Error('Proposal provenance is missing or changed (saved recording, intent, target or proposed payload). Regenerate the proposal against the current suite, review it, then accept again.');
}

/**
 * The recording an agent run captured for `scenario`, as the suite would
 * save it, when it differs from the saved one: { envelope, steps, previous,
 * diff, file }. Null when the run captured none, or the same, or one the
 * suite cannot hold. `url` is the --url the run used, if any.
 */
export function proposedRecording(run, project, suite, config, scenario, saved, { url, snapshot, failureRun } = {}) {
  if (recordingStatus(run, suite.kind, scenario).status !== 'recorded') return null;
  const file = join(run, 'recording', `${scenarioId(scenario.name)}.json`);
  let envelope;
  try { envelope = readRecordingFile(file); } catch { return null; }
  const handoff = effectiveHandoff(suite, config, project);
  if ((suite.kind === 'api' || suite.kind === 'web') && url) envelope = rebasedEnvelope(envelope, url, handoff.target?.url);
  if (!envelope) return null;
  let steps;
  try { steps = describeRecording(envelope, suite.kind, scenario, { handoff, scenario }); } catch { return null; }
  if (saved?.envelope && recordingHash(saved.envelope) === recordingHash(envelope)) return null;
  const baseline = snapshot ?? proposalSnapshot(project, suite, config, scenario);
  const failure = failureRun ? { run: failureRun.split('/').at(-1), executionIds: readExecutionRecords(failureRun).records.filter(r => r.scenarioName === scenario.name && r.mode === 'replay' && (r.outcome === 'FAIL' || r.assertion?.result === 'FAIL' || r.steps.some(s => s.assertion?.result === 'FAIL'))).map(r => r.id), assertions: saved?.steps?.map(s => s.assertion) ?? [] } : null;
  return { envelope, steps, previous: saved?.steps ?? null, diff: stepsDiff(saved?.steps, steps), file, provenance: { ...baseline, proposedHash: recordingHash(envelope) }, ...(failure ? { failure } : {}) };
}

/**
 * Write a recording beside its suite, replacing the scenario's old one.
 * The folder must be a plain folder; the file is replaced atomically.
 */
export function writeSuiteRecording(project, suiteName, envelope, options = {}) {
  if (typeof suiteName !== 'string' || !SUITE_NAME.test(suiteName)) throw new Error('Invalid suite name');
  projectFolder(project);
  const suites = join(project, '.toad', 'suites');
  if (!lstatSync(suites).isDirectory() || realpathSync(suites) !== suites) throw new Error('Recording acceptance needs a plain suites folder');
  const lock = join(suites, `.${suiteName}.recording-lock`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('Recording acceptance is already active or interrupted. Finish the other acceptance; remove the suite recording-lock folder only after verifying no writer is running.'); }
  try { return writeCheckedSuiteRecording(project, suiteName, envelope, options); }
  finally { rmdirSync(lock); }
}

function writeCheckedSuiteRecording(project, suiteName, envelope, { provenance } = {}) {
  if (typeof suiteName !== 'string' || !SUITE_NAME.test(suiteName)) throw new Error('Invalid suite name');
  validateRecording(envelope);
  const folder = projectFolder(project);
  const config = readProjectConfig(folder);
  const suite = readSuites(folder).find(s => s.name === suiteName);
  const scenario = suite?.scenarios.find(s => scenarioId(s.name) === envelope.scenarioId);
  if (!scenario) throw new Error('Recording has no matching suite scenario');
  describeRecording(envelope, suite.kind, scenario, { handoff: effectiveHandoff(suite, config, project), scenario });
  if (!recordingUnder(envelope, effectiveHandoff(suite, config, project).target?.url)) throw new Error('Recording is outside the current target');
  checkProposal(project, suite, scenario, envelope, provenance);
  if (Buffer.byteLength(recordingText(envelope), 'utf8') > 65536) throw new Error('Formatted recording exceeds 64 KiB; reduce supported literal data or re-record.');
  const suites = join(project, '.toad', 'suites');
  const dir = join(suites, `${suiteName}.recordings`);
  if (!lstatSync(suites).isDirectory() || realpathSync(suites) !== suites) throw new Error('.toad/suites must be a folder, not a symlink');
  try { mkdirSync(dir, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new Error(`.toad/suites/${suiteName}.recordings must be a folder, not a symlink`);
  const target = join(dir, `${envelope.scenarioId}.json`);
  const temp = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(temp, recordingText(envelope), { flag: 'wx', mode: 0o644 });
    // Recheck immediately before publication; serialize cooperative accept/update writers.
    checkProposal(project, suite, scenario, envelope, provenance);
    writeRecordingContext(project, suiteName, envelope, effectiveHandoff(suite, config, project).target?.url);
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

/** The effective handoff a suite runs with under the command line's overrides. */
export function runHandoff(handoff, config, project) { return withDefaults(handoff, config, project); }

export const ACCEPT_USAGE = `Usage: toad suites accept <run> --suite <name> [--project <dir>]
  Writes the recordings a finished run captured into
  .toad/suites/<name>.recordings/, replacing the saved ones they differ from.
  Only scenarios that passed, and recordings valid under the suite as it is
  now, are written. Review the change (git diff) and commit it.

  <run>               the run id, or its folder, as toad run and toad ui show it
  --suite <name>      the suite the recordings belong to
  --project <dir>     the project (default: the nearest folder with .toad/)`;

export class AcceptUsageError extends Error {}

export function parseAcceptArgs(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const [raw, inline] = argv[i].split(/=(.*)/s);
    if (!raw.startsWith('--')) { positional.push(argv[i]); continue; }
    const name = raw.slice(2);
    if (!['suite', 'project'].includes(name)) throw new AcceptUsageError(`Unknown option: ${raw}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw new AcceptUsageError(`${raw} needs a value`);
    if (out[name] !== undefined) throw new AcceptUsageError(`${raw} is given twice`);
    out[name] = value;
  }
  if (positional.length !== 1) throw new AcceptUsageError('Give exactly one run');
  if (!out.suite) throw new AcceptUsageError('--suite is required');
  return { ...out, run: positional[0] };
}

/**
 * Accept a run's captured recordings into a suite. Each suite scenario is
 * `accepted` (written), `unchanged` (the saved one is the same) or `none`.
 */
export function acceptRecordings(project, run, suiteName, { cwd = process.cwd() } = {}) {
  const folder = projectFolder(project);
  const config = readProjectConfig(folder);
  const suite = readSuites(folder).find(s => s.name === suiteName);
  if (!suite) throw new Error(`No suite named ${suiteName} in .toad/suites/`);
  const dir = runFolder(folder, run, cwd);
  let handoff;
  try { handoff = readRecordingFile(join(dir, 'handoff.yaml'), 1024 * 1024); } catch { throw new Error('The run has no readable handoff'); }
  if (handoff?.kind !== suite.kind) throw new Error(`The run is not a ${suite.kind} run, as ${suiteName} is`);
  const base = effectiveHandoff(suite, config, project).target?.url;
  const url = (suite.kind === 'api' || suite.kind === 'web') && handoff.target?.url && handoff.target.url !== base ? handoff.target.url : undefined;
  const inspection = inspectSuite(project, suite, config, { envelopes: true });
  if (inspection.errors.length) throw new DefinitionError(inspection.errors);
  const { recordings } = inspection;
  let state;
  try { state = readRecordingFile(join(dir, 'state.json'), 1024 * 1024); } catch { throw new Error('The run has no readable proposal provenance; regenerate and review proposals.'); }
  return suite.scenarios.map((scenario, i) => {
    const saved = recordings[i].status === 'recorded' ? recordings[i] : null;
    const stored = state.replay?.proposed?.[scenario.name];
    if (stored) {
      let candidate;
      try { candidate = readRecordingFile(join(dir, 'recording', `${scenarioId(scenario.name)}.json`)); }
      catch { throw new Error('Proposed recording is missing or invalid; regenerate and review the proposal.'); }
      if (url) candidate = rebasedEnvelope(candidate, url, base);
      if (!candidate) throw new Error('Proposed target changed; regenerate and review the proposal.');
      if (saved && recordingHash(saved.envelope) === recordingHash(candidate)) return { name: scenario.name, status: 'unchanged' };
      checkProposal(project, suite, scenario, candidate, stored.provenance);
    }
    const proposal = proposedRecording(dir, project, suite, config, scenario, saved, { url });
    if (!proposal) return { name: scenario.name, status: saved && recordingStatus(dir, suite.kind, scenario).status === 'recorded' ? 'unchanged' : 'none' };
    writeSuiteRecording(project, suite.name, proposal.envelope, { provenance: state.replay?.proposed?.[scenario.name]?.provenance });
    return { name: scenario.name, status: 'accepted', diff: proposal.diff };
  });
}

export { slug as scenarioFolder };
