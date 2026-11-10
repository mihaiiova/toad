/**
 * Saving a run as a suite, with its recordings beside it.
 *
 *   .toad/suites/<name>.yaml                    the suite (a handoff, plus tags and writes)
 *   .toad/suites/<name>.recordings/<id>.json    one recording per recorded scenario
 *
 * Saving is deliberate: `toad suites save` or the save_suite_from_run tool
 * writes new files and never overwrites one. Reading never writes. A
 * recording file is the run's envelope, stably formatted; it is used only
 * while it still matches its suite. Context-stale recordings and orphans warn;
 * corrupt/unsafe definitions carry diagnostics and block execution preflight.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { describeRecording, intentHash, readRecordingFile, recordingStatus, scenarioId, recordingText, validateRecording, recordingError } from './recordings.mjs';
import { definitionError, validateDefinition } from './definition-diagnostics.mjs';
import { originalTargetMatches, readRecordingContext, recordingUnder, writeRecordingContext } from './recording-context.mjs';
import { ensureDirectory, projectFolder, readProjectConfig, readSuites, suiteHandoff, suiteSchema, withDefaults, SUITE_NAME } from './projects.mjs';

/** The names readSuites accepts for .toad/suites/<name>.yaml. */
export { SUITE_NAME };
const READ_ONLY = 'This suite is declared read-only: do not create, change or delete data in the target.';
const RECORDING_FILE = /^([0-9a-f]{64})\.json$/;
const STALE = {
  changed: 'its kind, steps or expected result changed since it was recorded',
  unsupported: 'the suite now uses attempt hooks, credentials, installs, setup or PATH, or the codec no longer accepts it',
  invalid: 'the file is not a valid recording',
  target: 'the suite target changed; the recording is confined to its original target',
};

const EDITS = {
  cli: 'Edit payload.program and args (literal words), expect.exitCode (0–255), and expect.stdout (exactly equals or nonempty contains). No shell DSL, credentials, setup or PATH capture. Keep identity hashes unchanged.',
  api: 'Edit payload.method (GET/POST/PUT/PATCH/DELETE/HEAD), target-confined url, headers (accept/content-type only), literal body, expect.status (100–599) and expect.body (equals or nonempty contains). No credentials. Keep identity hashes unchanged.',
  web: 'Edit 2–30 bounded payload.steps: goto under target, click/fill with exact role/name, label or text locators, and expectVisible/expectText/expectUrl checks. Start with goto; end with a check. No credentials or selectors. Keep identity hashes unchanged.',
};

export const SAVE_USAGE = `Usage: toad suites save <run> --name <name> [options]
  Saves a finished run as .toad/suites/<name>.yaml, with the run's recordings in
  .toad/suites/<name>.recordings/. Nothing is overwritten; commit both.

  <run>               the run id, or its folder, as toad run and toad ui show it
  --name <name>       the suite name: letters, digits, ., _ or -
  --tag <tag>         tag the suite; repeatable
  --writes            the suite may create, change or delete data (toad run needs --allow-writes)
  --project <dir>     the project (default: the nearest folder with .toad/)`;

export class SaveUsageError extends Error {}

export function parseSaveArgs(argv) {
  const out = { tags: [], writes: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const [raw, inline] = argv[i].split(/=(.*)/s);
    if (!raw.startsWith('--')) { positional.push(argv[i]); continue; }
    const name = raw.slice(2);
    if (name === 'writes') { if (inline !== undefined) throw new SaveUsageError('--writes takes no value'); out.writes = true; continue; }
    if (!['name', 'tag', 'project'].includes(name)) throw new SaveUsageError(`Unknown option: ${raw}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw new SaveUsageError(`${raw} needs a value`);
    if (name === 'tag') out.tags.push(value);
    else if (out[name] !== undefined) throw new SaveUsageError(`${raw} is given twice`);
    else out[name] = value;
  }
  if (positional.length !== 1) throw new SaveUsageError('Give exactly one run');
  if (!out.name) throw new SaveUsageError('--name is required');
  return { ...out, run: positional[0] };
}

const present = path => {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

/** A plain directory at exactly this path: no symlink anywhere in it. */
function plainDirectory(path, label) {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error(`${label} must be a folder, not a symlink`);
}

/** The run folder for an id, or a path to one, inside the project's .toad/runs. */
export function runFolder(folder, run, cwd) {
  const runs = join(folder, 'runs');
  plainDirectory(runs, '.toad/runs');
  const id = run.includes('/') || run.includes('\\') ? basename(resolve(cwd, run)) : run;
  if (!SUITE_NAME.test(id) || (run !== id && resolve(cwd, run) !== join(runs, id))) throw new Error(`Not a run of this project: ${run}`);
  const dir = join(runs, id);
  if (!present(dir)) throw new Error(`No run ${id} in .toad/runs`);
  plainDirectory(dir, `.toad/runs/${id}`);
  return dir;
}

/** Target fields as the suite should hold them: what toad.yaml already sets is left out. */
function savedTarget(handoff, config, project) {
  const defaults = withDefaults({ kind: handoff.kind }, config, project).target;
  const target = {};
  for (const [key, value] of Object.entries(handoff.target ?? {})) {
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    if (key === 'workdir' && typeof value === 'string' && isAbsolute(value)) {
      const rel = relative(project, value);
      target[key] = rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? value : rel;
    } else target[key] = value;
  }
  return target;
}

/** The suite a run's effective handoff becomes. Throws, naming no values, if it cannot be one. */
export function suiteFromHandoff(handoff, config, project, { tags = [], writes = false } = {}) {
  if (!['web', 'cli', 'api'].includes(handoff?.kind)) throw new Error('The run has no valid handoff');
  const scenarios = handoff.request?.scenarios ?? [];
  if (!scenarios.length) throw new Error('The run has no scenarios to save; Toad derived them from the goal');
  const credentials = handoff.credentials ?? {};
  if (Object.values(credentials).some(c => !c || Object.keys(c).join(',') !== 'env' || typeof c.env !== 'string')) throw new Error('Only credential references ({ env: NAME }) can be saved in a suite');
  const target = savedTarget(handoff, config, project);
  const limitations = (handoff.limitations ?? []).filter(l => l !== READ_ONLY);
  const suite = {
    kind: handoff.kind,
    ...(handoff.title ? { title: handoff.title } : {}),
    ...(Object.keys(target).length ? { target } : {}),
    goal: handoff.request?.goal,
    ...(handoff.attempt ? { attempt: handoff.attempt } : {}),
    ...(tags.length ? { tags } : {}),
    writes: !!writes,
    ...(Object.keys(credentials).length ? { credentials } : {}),
    ...(handoff.allow_installs !== undefined ? { allow_installs: handoff.allow_installs } : {}),
    scenarios: scenarios.map(({ name, steps, expected }) => ({ name, steps, expected })),
    ...(limitations.length ? { limitations } : {}),
  };
  return validateDefinition({ data: suite }, suiteSchema, 'saved suite');
}

/** The handoff a saved suite runs with today: its own fields over toad.yaml's. */
export function effectiveHandoff(suite, config, project) {
  return withDefaults(suiteHandoff(suite), config, project);
}

/**
 * Save a finished run as a new suite. Each scenario whose run-local recording
 * is valid, and still valid under the suite as saved, is copied beside it;
 * the rest have none. Returns the files written and each scenario's status.
 */
export function saveSuiteFromRun(project, run, name, { tags = [], writes = false, cwd = process.cwd() } = {}) {
  if (typeof name !== 'string' || !SUITE_NAME.test(name)) throw new Error('A suite name is letters, digits, ., _ or -, starting with a letter or digit');
  const folder = projectFolder(project);
  const config = readProjectConfig(folder);
  const dir = runFolder(folder, run, cwd);
  let state;
  try { state = readRecordingFile(join(dir, 'state.json'), 1024 * 1024); } catch { throw new Error('The run has no readable state'); }
  if (state?.state !== 'finished') throw new Error('Only a finished run can be saved as a suite');
  let handoff;
  try { handoff = readRecordingFile(join(dir, 'handoff.yaml'), 1024 * 1024); } catch { throw new Error('The run has no readable handoff'); }
  const suite = suiteFromHandoff(handoff, config, project, { tags, writes });

  const suites = join(folder, 'suites');
  ensureDirectory(suites);
  plainDirectory(suites, '.toad/suites');
  for (const file of [`${name}.yaml`, `${name}.yml`, `${name}.recordings`, `${name}.recording-context.json`]) {
    if (present(join(suites, file))) throw new Error(`.toad/suites/${file} already exists; choose another name, or remove it first`);
  }

  const context = { handoff: effectiveHandoff({ name, ...suite }, config, project) };
  const copies = [];
  const scenarios = suite.scenarios.map(scenario => {
    if (recordingStatus(dir, suite.kind, scenario).status !== 'recorded') return { name: scenario.name, recording: 'none' };
    try {
      const envelope = readRecordingFile(join(dir, 'recording', `${scenarioId(scenario.name)}.json`));
      describeRecording(envelope, suite.kind, scenario, { ...context, scenario });
      if (Buffer.byteLength(recordingText(envelope), 'utf8') > 65536) return { name: scenario.name, recording: 'none' };
      copies.push(envelope);
      return { name: scenario.name, recording: 'recorded' };
    } catch { return { name: scenario.name, recording: 'none' }; }
  });

  const file = join(suites, `${name}.yaml`);
  const recordings = join(suites, `${name}.recordings`);
  let created = false;
  try {
    if (copies.length) {
      mkdirSync(recordings, { mode: 0o755 });
      created = true;
      for (const envelope of copies) {
        writeRecordingContext(project, name, envelope, context.handoff.target?.url);
        writeFileSync(join(recordings, `${envelope.scenarioId}.json`), recordingText(envelope), { flag: 'wx', mode: 0o644 });
      }
    }
    const header = `# Saved from run ${basename(dir)} with \`toad suites save\`. Commit it${copies.length ? ` with ${name}.recordings/${suite.kind !== 'cli' ? ` and ${name}.recording-context.json` : ''}` : ''}; it holds no secrets.\n`;
    writeFileSync(file, header + stringify(suite, { lineWidth: 0 }), { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (created) {
      rmSync(recordings, { recursive: true, force: true });
      rmSync(join(suites, `${name}.recording-context.json`), { force: true });
    }
    throw error;
  }
  return { suite: file, recordings: copies.length ? recordings : null, context: copies.length && suite.kind !== 'cli' ? join(suites, `${name}.recording-context.json`) : null, scenarios };
}

/**
 * Each scenario's saved recording: recorded (with readable steps), stale or
 * none, plus context/orphan warnings and hard definition diagnostics. Reads only.
 * With `envelopes`, a recorded scenario also carries the checked envelope.
 */
export function inspectSuite(project, suite, config, { envelopes = false } = {}) {
  if (typeof suite.name !== 'string' || !SUITE_NAME.test(suite.name)) throw new Error('Invalid suite name');
  const rel = `.toad/suites/${suite.name}.recordings`;
  const dir = join(project, '.toad', 'suites', `${suite.name}.recordings`);
  const none = () => suite.scenarios.map(() => ({ status: 'none' }));
  const warnings = [];
  const errors = [];
  let entries;
  try {
    // lstat: a symlinked folder is never followed. Files are opened O_NOFOLLOW.
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new Error('not a plain folder');
    entries = readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return { recordings: none(), warnings, errors };
    return { recordings: none(), warnings: [`${rel} is not a plain folder; its recordings are ignored`], errors: definitionError(null, { code: 'read' }, { file: dir, remedy: 'Replace this with a plain recording folder, or remove it and re-record.' }).diagnostics };
  }
  const files = new Map();
  for (const entry of entries) {
    const m = RECORDING_FILE.exec(entry);
    if (m) files.set(m[1], entry);
    else warnings.push(`${rel}/${entry}: not a recording file; ignored`);
  }
  const handoff = effectiveHandoff(suite, config, project);
  let originalContext;
  try { originalContext = readRecordingContext(project, suite.name); }
  catch (error) { errors.push(...(error.diagnostics ?? definitionError(null, { code: 'read' }, { file: `.toad/suites/${suite.name}.recording-context.json`, remedy: 'Restore or remove invalid recording context and re-record.' }).diagnostics)); }
  const recordings = suite.scenarios.map(scenario => {
    const id = scenarioId(scenario.name), entry = files.get(id);
    if (!entry) return { status: 'none' };
    files.delete(id);
    const stale = reason => {
      warnings.push(`${suite.name} › ${scenario.name}: the saved recording is stale (${STALE[reason]}); it is ignored`);
      return { status: 'stale', reason };
    };
    const invalid = error => {
      const diagnostics = error.diagnostics ?? definitionError(null, { code: 'read' }, { file: join(dir, entry), remedy: 'Use a regular recording file below 64 KiB without symlinks, or re-record.' }).diagnostics;
      errors.push(...diagnostics);
      return { ...stale('invalid'), diagnostics };
    };
    let value;
    try { value = readRecordingFile(join(dir, entry)); validateRecording(value); }
    catch (error) { return invalid(error); }
    if (value.scenarioId !== id) return invalid(recordingError(value, ['scenarioId']));
    // Check confinement even when intent is stale; context mismatch cannot hide corruption.
    if (suite.kind === value.kind && !recordingUnder(value, handoff.target?.url)) {
      if (originalContext && originalTargetMatches(originalContext, value)) return stale('target');
      return invalid(recordingError(value, ['payload', value.kind === 'web' ? 'steps' : 'url'], 'unsafe', 'Recording is outside the current target with no matching original-target provenance. Review the target and re-record; do not edit identity hashes.'));
    }
    if (value.kind !== suite.kind || value.intentHash !== intentHash(suite.kind, scenario)) return stale('changed');
    try { return { status: 'recorded', steps: describeRecording(value, suite.kind, scenario, { handoff, scenario }), ...(envelopes ? { envelope: value } : {}) }; }
    catch (error) {
      if (error.diagnostics?.every(d => d.code === 'context')) return stale('unsupported');
      return invalid(error);
    }
  });
  for (const entry of files.values()) warnings.push(`${rel}/${entry}: no scenario of ${suite.name} has this id (orphan); ignored`);
  return { recordings, warnings, errors };
}

/** Recording folders in .toad/suites with no suite of that name. */
export function orphanFolders(project, suites) {
  let entries;
  try { entries = readdirSync(join(project, '.toad', 'suites')); } catch { return []; }
  return entries.filter(e => e.endsWith('.recordings') && !suites.some(s => `${s.name}.recordings` === e)).sort()
    .map(e => `.toad/suites/${e}: no suite ${e.slice(0, -'.recordings'.length)}.yaml uses it (orphan); ignored`);
}

/** Warnings for the given suites' recordings and orphaned folders, for toad run. Never throws. */
export function recordingWarnings(project, suites, config, all = suites) {
  const warnings = [];
  for (const suite of suites) {
    try { warnings.push(...inspectSuite(project, suite, config).warnings); }
    catch { warnings.push(`.toad/suites/${suite.name}.recordings could not be checked; ignored`); }
  }
  return [...warnings, ...orphanFolders(project, all)];
}

/** Every saved suite with each scenario's recording, for the viewer. Reads only. */
export function suiteOverview(project) {
  const folder = join(project, '.toad');
  let config, suites;
  try { config = readProjectConfig(folder); suites = readSuites(folder); }
  catch (error) { return { suites: [], warnings: [], error: error.message }; }
  const warnings = [];
  const list = suites.map(suite => {
    const { recordings, warnings: own, errors } = inspectSuite(project, suite, config);
    warnings.push(...own);
    return {
      ...(errors.length ? { diagnostics: errors } : {}),
      edits: `${EDITS[suite.kind]} Assertion weakening requires review; complete-scenario capture is tester-attested, not a semantic proof.`,
      name: suite.name, kind: suite.kind, title: suite.title ?? null, tags: suite.tags ?? [], writes: !!suite.writes,
      scenarios: suite.scenarios.map((s, i) => ({ name: s.name, steps: s.steps, expected: s.expected, scenarioId: scenarioId(s.name), intentHash: intentHash(suite.kind, s), recordingFile: `.toad/suites/${suite.name}.recordings/${scenarioId(s.name)}.json`, recording: recordings[i] })),
    };
  });
  return { suites: list, warnings: [...warnings, ...orphanFolders(project, suites)] };
}
