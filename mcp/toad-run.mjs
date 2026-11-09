/**
 * `toad run`: run a project's saved suites without a coding agent, for CI.
 *
 * Suites are .toad/suites/<name>.yaml. Each selected suite is one Toad run
 * (shown in `toad ui` like any other); scenarios that do not pass are run once
 * more, and one that passes on the retry is reported as flaky. The result is
 * an exit code, and optionally JUnit XML, a markdown summary and JSON.
 *
 * A CLI, API or web scenario with a valid saved recording is replayed first,
 * without a model (mode `replay`); a web replay drives a fresh browser. One with none, or a stale one, or whose
 * replay assertion failed, goes to the agent (mode `agent`); when the agent
 * then passes it and captures a different recording, the scenario is
 * `healed` and the new recording is proposed, never written to the suite
 * unless --update-recordings or `toad suites accept` asks. A replay that
 * cannot run is an ERROR, not a reason to call the agent. Exit codes:
 *
 *   0  every scenario passed (flaky ones included)
 *   1  a scenario failed
 *   2  a run errored, was stopped, or its result is unknown
 *   3  Toad is not set up, or the suites, options or credentials are invalid
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { prepareAgent, providerReady, providersOf, resolveAgent, resolveModels } from './agent.mjs';
import { checkIgnore, ensureDirectory, readProjectConfig, readSuites, suiteHandoff } from './projects.mjs';

export const RUN_USAGE = `Usage: toad run [options]
  Runs the saved suites in .toad/suites/ and exits 0 (passed), 1 (a scenario
  failed), 2 (a run errored) or 3 (not set up, or invalid suites or options).

  --project <dir>             the project (default: the nearest folder with .toad/)
  --suite <name>              run this suite; repeat for more (default: every suite)
  --tag <tag>                 only scenarios tagged so, on the scenario or its suite; repeatable
  --max-scenarios <n>         run at most n scenarios, in suite and file order
  --url <url>                 the web or API URL to test, overriding the suites and toad.yaml
  --workdir <dir>             the CLI or API working folder, overriding them too
  --retries <n>               rerun what did not pass up to n times (default 1; 0 turns it off)
  --timeout <minutes>         each run's time limit (default: the suite's, then toad.yaml's, then 15)
  --lead-model <provider/id>  the lead model for this run, over toad.yaml and \`toad setup\`
  --tester-model <provider/id>
  --model <provider/id>       one model for both
  --env <NAME[,NAME]>         take these credentials from the environment, not .toad/.env
  --sandbox <kind>            auto, container, bwrap, or none (no isolation; only when asked)
  --max-cost <usd>            stop once Pi has recorded this much spend; the run is then an error
  --allow-writes              allow suites declared \`writes: true\`
  --no-replay                 run every scenario with the agent, ignoring saved recordings
  --update-recordings         write the recordings the agent captured beside the suites,
                              replacing saved ones that differ (review, then commit)
  --junit <file>              write JUnit XML, one test case per scenario
  --summary <file>            write a markdown summary, e.g. for a pull request comment
  --json                      print the result as JSON on stdout (progress goes to stderr)`;

export class UsageError extends Error {}

/** Parse `toad run` arguments; repeatable flags collect, `--env` splits on commas. */
export function parseRunArgs(argv) {
  const values = { suite: [], tag: [], env: [] };
  const takes = ['project', 'suite', 'tag', 'max-scenarios', 'url', 'workdir', 'retries', 'timeout', 'lead-model', 'tester-model', 'model', 'env', 'sandbox', 'max-cost', 'junit', 'summary'];
  const flags = ['json', 'allow-writes', 'no-replay', 'update-recordings'];
  for (let i = 0; i < argv.length; i++) {
    const [raw, inline] = argv[i].split(/=(.*)/s);
    const name = raw.replace(/^--/, '');
    if (!raw.startsWith('--')) throw new UsageError(`Unexpected argument: ${argv[i]}`);
    if (flags.includes(name)) { if (inline !== undefined) throw new UsageError(`${raw} takes no value`); values[name] = true; continue; }
    if (!takes.includes(name)) throw new UsageError(`Unknown option: ${raw}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw new UsageError(`${raw} needs a value`);
    if (name === 'env') values.env.push(...value.split(',').map(v => v.trim()).filter(Boolean));
    else if (Array.isArray(values[name])) values[name].push(value);
    else if (values[name] !== undefined) throw new UsageError(`${raw} is given twice`);
    else values[name] = value;
  }
  const number = (flag, { min, integer = true }) => {
    if (values[flag] === undefined) return undefined;
    const n = Number(values[flag]);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) throw new UsageError(`--${flag} must be ${integer ? 'a whole number' : 'a number'} of at least ${min}`);
    return n;
  };
  const ref = flag => {
    if (values[flag] !== undefined && !/^[^/\s]+\/\S+$/.test(values[flag])) throw new UsageError(`--${flag} needs provider/id, as \`pi --list-models\` prints it`);
    return values[flag];
  };
  if (values.sandbox !== undefined && !['auto', 'container', 'bwrap', 'none'].includes(values.sandbox)) throw new UsageError('--sandbox must be auto, container, bwrap or none');
  for (const name of values.env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`--env: not a variable name: ${name}`);
  if (values.url !== undefined) { try { new URL(values.url); } catch { throw new UsageError(`--url is not a URL: ${values.url}`); } }
  if (values.model && (values['lead-model'] || values['tester-model'])) throw new UsageError('Use --model, or --lead-model and --tester-model, not both');
  return {
    project: values.project, suites: values.suite, tags: values.tag, env: [...new Set(values.env)],
    maxScenarios: number('max-scenarios', { min: 1 }), retries: number('retries', { min: 0 }) ?? 1, timeout: number('timeout', { min: 1 }),
    maxCost: number('max-cost', { min: 0, integer: false }), url: values.url, workdir: values.workdir, sandbox: values.sandbox,
    models: { lead: ref('lead-model') ?? ref('model'), tester: ref('tester-model') ?? values.model },
    allowWrites: !!values['allow-writes'], json: !!values.json, junit: values.junit, summary: values.summary,
    replay: !values['no-replay'], updateRecordings: !!values['update-recordings'],
  };
}

/** The nearest folder at or above `from` holding .toad/, as a canonical path. */
export function findProject(from) {
  for (let dir = realpathSync(resolve(from)); ; dir = dirname(dir)) {
    try { if (lstatSync(join(dir, '.toad')).isDirectory()) return dir; } catch {}
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The scenarios to run, suite by suite: the chosen suites (all, in name
 * order, by default), scenarios matching a tag on themselves or their suite,
 * capped at `max` in that order. Never random, so a run is reproducible.
 */
export function selectScenarios(suites, { names = [], tags = [], max } = {}) {
  const unknown = names.filter(name => !suites.some(s => s.name === name));
  if (unknown.length) throw new UsageError(`No suite named ${unknown.join(', ')} in .toad/suites/ (found: ${suites.map(s => s.name).join(', ') || 'none'})`);
  const chosen = names.length ? [...new Set(names)].map(name => suites.find(s => s.name === name)) : suites;
  let left = max ?? Infinity;
  const plan = [];
  for (const suite of chosen) {
    const scenarios = suite.scenarios.filter(s => !tags.length || tags.some(tag => (s.tags ?? []).includes(tag) || (suite.tags ?? []).includes(tag))).slice(0, left);
    left -= scenarios.length;
    if (scenarios.length) plan.push({ suite, scenarios });
  }
  return plan;
}

/** A suite's handoff with the command line's target overrides applied. */
export function suiteRunHandoff(suite, scenarios, { url, workdir } = {}) {
  const handoff = suiteHandoff(suite, scenarios);
  const target = { ...handoff.target };
  if (url && suite.kind !== 'cli') target.url = url;
  if (workdir && suite.kind !== 'web') target.workdir = resolve(workdir);
  return { ...handoff, ...(Object.keys(target).length ? { target } : {}) };
}

/** Reject contradictory absolute target URLs before asking an agent to choose. */
export function conflictingOverride(suite, scenario, config, project, override) {
  if (!override || !['web', 'api'].includes(suite.kind)) return false;
  let original, replacement;
  try {
    original = new URL(replayTarget(suite, config, project));
    replacement = new URL(override);
  } catch { return true; }
  if (original.href.replace(/\/$/, '') === replacement.href.replace(/\/$/, '')) return false;
  const under = (url, base) => {
    const prefix = base.pathname.replace(/\/+$/, '') || '/';
    return url.origin === base.origin && (prefix === '/' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  };
  return [suite.goal, scenario.steps, scenario.expected, ...(suite.limitations ?? [])].some(text => {
    if (typeof text !== 'string') return false;
    return [...text.matchAll(/https?:\/\/[^\s<>"'“”‘’]+/gi)].some(match => {
      try {
        const referenced = new URL(match[0].replace(/[),.;!?]+$/, ''));
        return under(referenced, original) && !under(referenced, replacement);
      } catch { return true; }
    });
  });
}
function replayTarget(suite, config, project) {
  const defaults = config[suite.kind] ?? {};
  return suite.target?.url ?? defaults.url;
}

/** Why a scenario has no result, by how its run ended. */
const STATUS = {
  cost_limit: 'Stopped at the spending limit', timeout: 'The run timed out', cancelled: 'The run was cancelled',
  setup_failed: 'Setup failed, so no scenario ran', error: 'The run errored', blocked: 'The run was blocked waiting for approval',
  configuration_error: 'The agent is misconfigured',
};

/** A scenario's receipts folder name, as the lead is told to make it. */
export const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

/**
 * Each scenario's outcome from one run's result. A report without results
 * leaves them unknown: PASS only when the whole run passed, else ERROR. In a
 * run that did not complete, a reported failure stands but a pass does not.
 */
export function outcomes(scenarios, result) {
  const ok = result?.status === 'ok';
  const reported = new Map((result?.scenarios ?? []).map(s => [s.name.trim().toLowerCase(), s.result]));
  const fallback = ok && result?.verdict === 'PASS' && !reported.size ? 'PASS' : 'ERROR';
  return scenarios.map(s => {
    const got = reported.get(s.name.trim().toLowerCase()) ?? fallback;
    return got === 'PASS' && !ok ? 'ERROR' : got;
  });
}

/** Combine a scenario's attempts: a pass after a failure is FLAKY. */
export function finalResult(attempts) {
  const last = attempts.at(-1);
  return last === 'PASS' && attempts.length > 1 ? 'FLAKY' : last;
}

export function exitCodeOf(results) {
  if (results.includes('FAIL')) return 1;
  if (results.some(r => r !== 'PASS' && r !== 'FLAKY')) return 2;
  return 0;
}

const xml = text => String(text ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])
  // XML 1.0 has no form for most control characters.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** JUnit XML: one test suite per Toad suite, one test case per scenario. */
export function junit(report) {
  const count = (list, r) => list.filter(s => s.result === r).length;
  const all = report.suites.flatMap(s => s.scenarios);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="toad" tests="${all.length}" failures="${count(all, 'FAIL')}" errors="${count(all, 'ERROR')}" time="${report.seconds.toFixed(1)}">`];
  for (const suite of report.suites) {
    lines.push(`  <testsuite name="${xml(suite.name)}" tests="${suite.scenarios.length}" failures="${count(suite.scenarios, 'FAIL')}" errors="${count(suite.scenarios, 'ERROR')}" skipped="0" time="${suite.seconds.toFixed(1)}">`);
    for (const s of suite.scenarios) {
      const evidence = [`Result: ${s.result}${s.attempts.length > 1 ? ` (attempts: ${s.attempts.join(', ')})` : ''}`,
        ...(s.mode ? [`Mode: ${s.mode}${s.replay === 'FAIL' ? ' (the saved recording failed; the agent checked it)' : ''}`] : []),
        ...(s.message ? [s.message] : []), ...(s.report ? [`Report: ${s.report}`] : []), ...(s.receipts ? [`Receipts: ${s.receipts}`] : []),
        ...(s.proposed ? [`Proposed recording: ${s.proposed.updated ?? s.proposed.recording}${s.proposed.updated ? ' (written to the suite)' : ''}`] : [])].join('\n');
      lines.push(`    <testcase classname="toad.${xml(suite.name)}" name="${xml(s.name)}">`);
      const props = [...(s.result === 'FLAKY' ? ['<property name="flaky" value="true"/>'] : []), ...(s.mode ? [`<property name="toad.mode" value="${xml(s.mode)}"/>`] : []), ...(s.proposed ? ['<property name="toad.proposed" value="true"/>'] : [])];
      if (props.length) lines.push(`      <properties>${props.join('')}</properties>`);
      if (s.result === 'FAIL') lines.push(`      <failure message="${xml(`${s.name} failed`)}" type="FAIL">${xml(evidence)}</failure>`);
      if (s.result === 'ERROR') lines.push(`      <error message="${xml(s.message || `${s.name} could not be tested`)}" type="ERROR">${xml(evidence)}</error>`);
      lines.push(`      <system-out>${xml(evidence)}</system-out>`, '    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return lines.join('\n') + '\n';
}

/** How many scenarios each mode decided: replayed, by the agent, healed. */
const modeText = modes => [`${modes.replay} replayed`, `${modes.agent} by the agent`, modes.healed && `${modes.healed} healed`].filter(Boolean).join(', ');

const duration = seconds => (seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${seconds.toFixed(0)}s`);

/** A markdown summary for a pull request comment or a CI job summary. */
export function summary(report) {
  const all = report.suites.flatMap(s => s.scenarios.map(x => ({ ...x, suite: s.name })));
  const n = r => all.filter(s => s.result === r).length;
  const counts = [`${n('PASS')} passed`, n('FAIL') && `${n('FAIL')} failed`, n('FLAKY') && `${n('FLAKY')} flaky`, n('ERROR') && `${n('ERROR')} errored`].filter(Boolean).join(', ');
  const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`## Toad: ${report.verdict}`, '',
    `${counts} · ${duration(report.seconds)}${report.cost !== undefined ? ` · $${report.cost.toFixed(4)}` : ''}`, ''];
  if (report.modes) lines.push(`Modes: ${modeText(report.modes)}${report.proposed ? ` · ${report.proposed} proposed recording${report.proposed === 1 ? '' : 's'}` : ''}`, '');
  if (all.length) {
    lines.push('| Result | Suite | Scenario | Evidence |', '|---|---|---|---|');
    for (const s of all) lines.push(`| ${s.result} | ${cell(s.suite)} | ${cell(s.name)} | ${s.receipts ? `\`${cell(s.receipts)}\`` : s.message ? cell(s.message) : ''} |`);
    lines.push('');
  }
  const flaky = all.filter(s => s.result === 'FLAKY');
  if (flaky.length) lines.push(`Flaky (failed, then passed on a retry): ${flaky.map(s => s.name).join(', ')}.`, '');
  for (const note of report.notes) lines.push(`> ${note}`, '');
  const runs = report.suites.flatMap(s => s.runs.map(r => r.folder)).filter(Boolean);
  if (runs.length) lines.push('Runs:', ...runs.map(r => `- \`${r}\``), '');
  return lines.join('\n');
}

/** The models a run would use, for the key check: the override, or what the agent runs on. */
function effectiveModels(agent, flags, config) {
  return resolveModels(agent, { flags: Object.fromEntries(Object.entries(flags).filter(([, v]) => v)), project: config.models });
}

/**
 * Run `toad run` with parsed options. `io.out` gets the result (JSON or
 * text), `io.err` the progress. Returns the exit code.
 */
export async function toadRun(options, { cwd = process.cwd(), env = process.env, out = text => process.stdout.write(text), err = text => process.stderr.write(text), signal = new AbortController().signal } = {}) {
  const say = text => (options.json ? err : out)(text + '\n');
  const fatal = message => { err(`toad run: ${message}\n`); return 3; };

  const project = options.project ? realpathSync(resolve(cwd, options.project)) : findProject(cwd);
  if (!project || !existsSync(join(project, '.toad'))) return fatal(`no .toad/ folder ${options.project ? `in ${options.project}` : `here or above ${cwd}`}. Set Toad up in the project first (the setup_project tool) and commit .toad/.`);
  const folder = join(project, '.toad');
  let config, suites, plan;
  try {
    if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder) throw new Error('.toad must be a plain folder, not a symlink');
    checkIgnore(join(folder, '.gitignore'));
    config = readProjectConfig(folder);
    suites = readSuites(folder);
    plan = selectScenarios(suites, { names: options.suites, tags: options.tags, max: options.maxScenarios });
  } catch (error) { return fatal(error.message); }
  if (!suites.length) return fatal('no suites in .toad/suites/. Save one as .toad/suites/<name>.yaml; see .toad/suites/example.yaml.');
  if (!plan.length) return fatal(`no scenario matches${options.tags.length ? ` the tags ${options.tags.join(', ')}` : ''}`);
  const writers = plan.filter(p => p.suite.writes).map(p => p.suite.name);
  if (writers.length && !options.allowWrites) return fatal(`${writers.join(', ')} ${writers.length === 1 ? 'is' : 'are'} declared \`writes: true\` (it may create, change or delete data). Pass --allow-writes to run ${writers.length === 1 ? 'it' : 'them'}.`);
  // Saved recordings that no longer match are reported, never fatal: the suite runs as written.
  const { recordingWarnings } = await import('./suite-recordings.mjs');
  const warnings = recordingWarnings(project, plan.map(p => p.suite), config, suites);
  for (const warning of warnings) err(`toad run: warning: ${warning}\n`);

  // Each scenario replays its saved recording when it has a usable one; the rest go to the agent.
  const replay = await import('./replay.mjs');
  const choices = new Map(plan.map(p => [p.suite.name, replay.replayChoices(project, p.suite, config, p.scenarios, { replay: options.replay !== false, url: options.url })]));
  const agentFirst = plan.some(p => choices.get(p.suite.name).some(c => c.mode !== 'replay'));

  // A CI runner has no `toad setup`: prepare the agent on first use. A run
  // that only replays never needs it, so never needs a model key.
  let ready;
  const readyAgent = async () => {
    if (ready) return ready;
    let agent = resolveAgent(env);
    if (!agent) {
      say('Preparing the testing agent (first run on this machine)…');
      try { agent = prepareAgent({ log: text => say(`  ${text}`) }); }
      catch (error) { return (ready = { error: `could not prepare the agent: ${error.message}` }); }
    }
    let models;
    try { models = effectiveModels(agent, options.models, config); } catch (error) { return (ready = { error: error.message }); }
    for (const provider of providersOf(models)) {
      if (providerReady(agent, provider, env)) continue;
      const { keyEnv } = await import('./models.mjs');
      const name = await keyEnv(provider).catch(() => undefined);
      return (ready = { error: `no key for ${provider}, which ${models.lead.startsWith(`${provider}/`) ? models.lead : models.tester} needs. ${name ? `Set ${name} in the environment` : 'Sign in with `toad setup`'}, then retry.` });
    }
    // Likewise the browser, the first time a web suite needs it.
    if (plan.some(p => p.suite.kind === 'web')) {
      const { browserInstalled, installBrowser } = await import('./setup.mjs');
      if (!browserInstalled(env)) {
        say('Installing the browser for web tests (first run on this machine)…');
        const result = await installBrowser(agent);
        if (result.status !== 0) return (ready = { error: `could not install the browser: ${result.output.trim().split('\n').slice(-3).join(' ')}` });
      }
    }
    return (ready = { ok: true });
  };
  if (agentFirst) { const r = await readyAgent(); if (r.error) return fatal(r.error); }
  // In CI, .toad/runs/ is not committed.
  try { ensureDirectory(join(folder, 'runs')); } catch (error) { return fatal(error.message); }

  const { runProject, writeState } = await import('./run.mjs');
  const started = Date.now();
  const notes = [];
  if (options.sandbox === 'none' && plan.some(p => p.suite.kind !== 'web')) notes.push('CLI and API commands ran without a sandbox (--sandbox none), directly on this machine.');
  let spent = 0, stopped = false, setupError = false;
  const report = { project, verdict: 'PASS', suites: [], notes, ...(warnings.length ? { warnings } : {}) };
  const rel = path => (path ? relative(project, path) || '.' : undefined);
  const accepts = [];

  for (const { suite, scenarios } of plan) {
    const choice = new Map(scenarios.map((s, i) => [s.name, choices.get(suite.name)[i]]));
    const entry = { name: suite.name, kind: suite.kind, seconds: 0, runs: [], scenarios: scenarios.map(s => ({ name: s.name, attempts: [], mode: choice.get(s.name).mode, ...(choice.get(s.name).reason ? { reason: choice.get(s.name).reason } : {}) })) };
    report.suites.push(entry);
    const at = name => entry.scenarios.find(x => x.name === name);
    const toAgent = new Set(scenarios.filter(s => choice.get(s.name).mode !== 'replay').map(s => s.name));
    const proposals = new Map(), agentRuns = [];
    let replayRun;

    // Replays first: free, deterministic, and no model.
    const replays = scenarios.filter(s => choice.get(s.name).mode === 'replay');
    if (replays.length && (signal.aborted || stopped)) {
      for (const s of replays) { at(s.name).attempts.push('ERROR'); at(s.name).message = signal.aborted ? 'Not run: toad run was interrupted' : 'Not run: the spending limit was reached'; }
    } else if (replays.length) {
      say(`Replaying ${suite.name}: ${replays.length} saved recording${replays.length === 1 ? '' : 's'}, without a model…`);
      const handoff = replay.runHandoff(suiteRunHandoff(suite, replays, options), config, project);
      const timeoutMs = Number(env.TOAD_TEST_TIMEOUT_MS) || (options.timeout ?? suite.timeout_minutes ?? config.timeout_minutes ?? 15) * 60000;
      const replaySignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const t0 = Date.now();
      // A web replay needs the browser, though not the agent or a model.
      let browserError;
      if (suite.kind === 'web' && !env.TOAD_WEB_DRIVER) {
        const { browserInstalled, installBrowser } = await import('./setup.mjs');
        if (!browserInstalled(env)) {
          say('Installing the browser for web tests (first run on this machine)…');
          const result = await installBrowser(join(import.meta.dirname, '..', 'agent'));
          if (result.status !== 0) browserError = `could not install the browser: ${result.output.trim().split('\n').slice(-3).join(' ')}`;
        }
      }
      if (browserError) {
        say(`  ${browserError}`);
        for (const s of replays) { at(s.name).attempts.push('ERROR'); at(s.name).message = `The replay could not start: ${browserError}`; }
      } else try {
        replayRun = replay.startReplayRun(project, handoff, { sandbox: options.sandbox });
        say(`  run: ${rel(replayRun)}`);
      } catch (error) {
        say(`  ${error.message}`);
        for (const s of replays) { at(s.name).attempts.push('ERROR'); at(s.name).message = `The replay could not start: ${error.message}`; }
      }
      if (replayRun) {
        const results = [];
        const receiptsRoot = join(replayRun, 'receipts');
        for (const scenario of replays) {
          const s = at(scenario.name), envelope = choice.get(scenario.name).envelope;
          const receipts = join(receiptsRoot, slug(scenario.name));
          let outcome;
          // Retries cover a replay that could not run; a failed assertion goes to the agent instead.
          for (let attempt = 0; attempt <= options.retries; attempt++) {
            if (replaySignal.aborted) { outcome = { result: 'ERROR', message: signal.aborted ? 'Not run: toad run was interrupted' : 'The replay run timed out' }; s.attempts.push('ERROR'); break; }
            outcome = await replay.replayScenario(envelope, { workdir: handoff.target?.workdir, targetUrl: suite.kind === 'web' ? handoff.target?.url : undefined, receipts, name: `${String(attempt + 1).padStart(2, '0')}-replay`, env: replay.replayEnv(env, { receipts: receiptsRoot, sandbox: options.sandbox, image: handoff.target?.image }), signal: replaySignal });
            if (outcome.result === 'FAIL') break;
            s.attempts.push(outcome.result);
            if (outcome.result === 'PASS') break;
          }
          results.push({ scenario, envelope, ...outcome });
          s.receipts = rel(existsSync(receipts) ? receipts : receiptsRoot);
          s.report = rel(join(replayRun, 'reports', 'report.md'));
          if (outcome.result === 'FAIL') {
            s.replay = 'FAIL'; s.mode = 'agent'; s.reason = "the saved recording's assertion failed";
            toAgent.add(scenario.name);
          } else if (outcome.result === 'ERROR') s.message = outcome.message;
          else delete s.message;
        }
        const seconds = (Date.now() - t0) / 1000;
        entry.seconds += seconds;
        const finished = replay.finishReplayRun(replayRun, handoff, results, { suite: suite.name });
        entry.runs.push({ folder: rel(replayRun), status: finished.status, verdict: finished.verdict, seconds: Number(seconds.toFixed(1)), replay: true });
      }
    }

    // The agent: scenarios without a usable recording, and replays whose assertion failed.
    let pending = scenarios.filter(s => toAgent.has(s.name));
    for (const p of pending.filter(s => conflictingOverride(suite, s, config, project, options.url))) {
      const s = at(p.name);
      s.attempts.push('ERROR');
      if (s.replay === 'FAIL') s.mode = 'replay';
      s.message = 'The suite contains an absolute URL for the original target, which conflicts with --url. Replace it with a target-relative path before retrying; the agent was not run.';
    }
    pending = pending.filter(s => !conflictingOverride(suite, s, config, project, options.url));
    if (pending.length && !signal.aborted && !stopped) {
      const r = await readyAgent();
      if (r.error) {
        say(`  ${r.error}`);
        for (const p of pending) { const s = at(p.name); s.attempts.push('ERROR'); s.message = `${s.replay === 'FAIL' ? "The saved recording's assertion failed, and the agent could not check the scenario" : 'The agent could not run'}: ${r.error}`; }
        setupError = true;
        pending = [];
      }
    }
    for (let attempt = 0; attempt <= options.retries && pending.length; attempt++) {
      const pick = entry.scenarios.filter(s => pending.some(p => p.name === s.name));
      if (signal.aborted || stopped) { for (const s of pick) { s.attempts.push('ERROR'); s.message ??= signal.aborted ? 'Not run: toad run was interrupted' : 'Not run: the spending limit was reached'; } break; }
      const left = options.maxCost !== undefined ? options.maxCost - spent : undefined;
      say(`${attempt ? 'Retrying' : 'Running'} ${suite.name}: ${pending.length} scenario${pending.length === 1 ? '' : 's'}${attempt ? ' that did not pass' : ''}…`);
      const handoff = suiteRunHandoff(suite, pending, options);
      const t0 = Date.now();
      let result, folderOf;
      try {
        const tool = await runProject({ project_path: project, handoff, timeout_minutes: options.timeout ?? suite.timeout_minutes, screenshots: 'paths' }, {
          signal,
          progress: (message, seconds) => { if (seconds && seconds % 60 < 15) err(`  ${suite.name}: ${message} (${duration(seconds)})\n`); },
        }, { env, envNames: options.env, sandbox: options.sandbox, models: options.models, maxCost: left, origin: 'cli', onRun: dir => { folderOf = dir; say(`  run: ${rel(dir)}`); }, log: text => say(`  ${text}`) });
        result = tool.structuredContent;
        if (tool.isError) say(`  ${tool.content[0].text.split('\n')[0]}`);
      } catch (error) {
        // Raised before the run started: a missing credential, an invalid target.
        say(`  ${error.message}`);
        for (const s of pick) { s.attempts.push('ERROR'); s.message = error.message; }
        setupError = true;
        entry.runs.push({ folder: rel(folderOf), status: 'not_started', error: error.message });
        break;
      }
      const seconds = (Date.now() - t0) / 1000;
      entry.seconds += seconds;
      spent += result.cost ?? 0;
      entry.runs.push({ folder: rel(result.run), status: result.status, verdict: result.verdict, seconds: Number(seconds.toFixed(1)), ...(result.cost !== undefined ? { cost: result.cost } : {}) });
      if (result.status === 'cost_limit') { stopped = true; notes.push(`Stopped at the spending limit of $${options.maxCost}.`); }
      const got = outcomes(pending, result);
      agentRuns.push({ run: result.run, names: pending.map(p => p.name) });
      pending.forEach((p, i) => {
        const s = entry.scenarios.find(x => x.name === p.name);
        s.attempts.push(got[i]);
        const own = join(result.receipts, slug(p.name));
        s.receipts = rel(existsSync(own) ? own : result.receipts);
        s.report = rel(join(result.run, 'reports', 'report.md'));
        if (got[i] === 'ERROR' && result.status !== 'ok') s.message = STATUS[result.status] ?? `The run ended with status ${result.status}`;
        else if (got[i] !== 'ERROR') delete s.message;
        // A pass that captured a recording unlike the saved one proposes it; the saved one stays.
        if (got[i] === 'PASS' && result.run) {
          const c = choice.get(p.name);
          try {
            const proposal = replay.proposedRecording(result.run, project, suite, config, p, c.saved ? { envelope: c.saved, steps: c.savedSteps } : null, { url: suite.kind === 'api' || suite.kind === 'web' ? options.url : undefined });
            if (proposal) proposals.set(p.name, { ...proposal, run: result.run });
          } catch { /* a proposal never changes the result */ }
        }
      });
      // A run that was stopped, or never got going, is not worth repeating.
      if (['cost_limit', 'cancelled', 'configuration_error'].includes(result.status) || signal.aborted) break;
      pending = pending.filter((p, i) => got[i] !== 'PASS');
    }
    for (const s of entry.scenarios) {
      s.result = finalResult(s.attempts.length ? s.attempts : ['ERROR']);
      const proposal = proposals.get(s.name);
      if (proposal && (s.result === 'PASS' || s.result === 'FLAKY')) {
        const c = choice.get(s.name);
        if (s.replay === 'FAIL') s.mode = 'healed';
        s.proposed = { recording: rel(proposal.file), run: rel(proposal.run), steps: proposal.steps, previous: proposal.previous, diff: proposal.diff };
        if (options.updateRecordings) {
          try { s.proposed.updated = rel(replay.writeSuiteRecording(project, suite.name, proposal.envelope)); }
          catch (error) { s.proposed.error = error.message; notes.push(`Could not update the recording of ${suite.name} › ${s.name}: ${error.message}`); }
        }
        if (!s.proposed.updated) {
          s.proposed.accept = `toad suites accept ${basename(proposal.run)} --suite ${suite.name}`;
          if (!accepts.includes(s.proposed.accept)) accepts.push(s.proposed.accept);
        }
      }
      say(`  ${s.result.padEnd(5)} ${suite.name} › ${s.name}${s.attempts.length > 1 ? ` (${s.attempts.join(' → ')})` : ''}${s.mode === 'agent' ? '' : ` [${s.mode}]`}${s.proposed ? s.proposed.updated ? ' (recording updated)' : ' (new recording proposed)' : ''}`);
    }
    // What each run decided, for `toad ui`.
    const uiModes = names => Object.fromEntries(names.map(name => [name, at(name).mode]));
    const uiProposed = run => Object.fromEntries(entry.scenarios.filter(s => s.proposed && proposals.get(s.name)?.run === run)
      .map(s => [s.name, { steps: s.proposed.steps, previous: s.proposed.previous, diff: s.proposed.diff, ...(s.proposed.updated ? { updated: true } : {}) }]));
    if (replayRun) writeState(replayRun, { replay: { suite: suite.name, modes: Object.fromEntries(replays.map(s => [s.name, 'replay'])) } });
    for (const { run, names } of agentRuns) {
      if (!run) continue;
      const proposed = uiProposed(run);
      const accept = Object.values(proposed).some(p => !p.updated) ? `toad suites accept ${basename(run)} --suite ${suite.name}` : undefined;
      writeState(run, { replay: { suite: suite.name, modes: uiModes(names), ...(replayRun ? { priorRun: basename(replayRun) } : {}), ...(Object.keys(proposed).length ? { proposed } : {}), ...(accept ? { accept } : {}) } });
    }
  }

  const all = report.suites.flatMap(s => s.scenarios);
  report.modes = Object.fromEntries(['replay', 'agent', 'healed'].map(m => [m, all.filter(s => s.mode === m).length]));
  const proposedCount = all.filter(s => s.proposed).length;
  if (proposedCount) report.proposed = proposedCount;
  const updated = all.filter(s => s.proposed?.updated).length;
  if (updated) notes.push(`Updated ${updated} saved recording${updated === 1 ? '' : 's'} beside the suites; review the change (git diff) and commit it.`);
  if (accepts.length) notes.push(`The agent captured ${proposedCount - updated} new recording${proposedCount - updated === 1 ? '' : 's'}; the saved ones are unchanged. Review, then accept with: ${accepts.map(a => `\`${a}\``).join(', ')}`);

  const results = report.suites.flatMap(s => s.scenarios.map(x => x.result));
  report.exitCode = setupError && !results.includes('FAIL') ? 3 : exitCodeOf(results);
  report.verdict = { 0: 'PASS', 1: 'FAIL', 2: 'ERROR', 3: 'ERROR' }[report.exitCode];
  report.seconds = (Date.now() - started) / 1000;
  if (spent || options.maxCost !== undefined) report.cost = Number(spent.toFixed(6));
  const write = (path, text) => { const file = resolve(cwd, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  if (options.junit) write(options.junit, junit(report));
  if (options.summary) write(options.summary, summary(report));
  if (options.json) out(JSON.stringify(report, null, 2) + '\n');
  else {
    say(`${report.verdict}: ${results.filter(r => r === 'PASS' || r === 'FLAKY').length} of ${results.length} passed${results.includes('FLAKY') ? ` (${results.filter(r => r === 'FLAKY').length} flaky)` : ''} in ${duration(report.seconds)}${report.cost !== undefined ? `, $${report.cost.toFixed(4)}` : ''}`);
    if (report.modes.replay || report.modes.healed) say(`Modes: ${modeText(report.modes)}`);
    for (const note of notes.filter(n => /recording/.test(n))) say(note);
  }
  return report.exitCode;
}
