/**
 * Where the testing agent lives, how it is prepared, and how a workflow is
 * launched without the bash `run` script.
 *
 * The npm package ships the agent's definition (agent/). It is never run in
 * place: `toad setup` copies it to <data>/agent/<version>/ and installs its
 * pinned Pi packages there, so an update gets a fresh copy while the model keys
 * stay in <config>/credentials.json and the chosen models in
 * <config>/settings.json. A git checkout whose agent/ has already been set up
 * with ./run is used in place, for development.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, closeSync, constants, fstatSync, openSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
export const TEMPLATE = join(PACKAGE_ROOT, 'agent');
const FORGE = join('.pi', 'git', 'github.com', 'mihaiiova', 'pi-forge', 'skills', 'forge');
const RUNNER = join(FORGE, 'workflow-runner.mjs');
const READY = '.toad-ready.json';

/** The folder holding the `pi` command this package depends on. */
export function piBinDir() {
  // npm puts dependency commands in the nearest node_modules/.bin above us.
  for (let dir = PACKAGE_ROOT; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin');
    if (existsSync(join(bin, 'pi')) || existsSync(join(bin, 'pi.cmd'))) return bin;
    if (dirname(dir) === dir) return null;
  }
}

/** PATH with the packaged `pi` first, so the agent never needs a global install. */
export function pathWithPi(env = process.env) {
  const bin = piBinDir();
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { key, value: bin ? [bin, env[key]].filter(Boolean).join(delimiter) : env[key] };
}

export function installedAgentDir(version = VERSION) { return join(toadDirs().data, 'agent', version); }
const isReady = dir => existsSync(join(dir, READY)) && existsSync(join(dir, RUNNER));

/**
 * The agent a run uses: TOAD_AGENT_DIR, else a set-up git checkout's agent/,
 * else this version's prepared copy. Null when none is ready.
 */
export function resolveAgent(env = process.env) {
  if (env.TOAD_AGENT_DIR) return resolve(env.TOAD_AGENT_DIR);
  if (existsSync(join(TEMPLATE, RUNNER))) return TEMPLATE;
  const installed = installedAgentDir();
  return isReady(installed) ? installed : null;
}

/** The files that define the agent; everything else in agent/ is runtime state. */
const DEFINITION = ['run', '.gitignore', join('.pi', 'system.yaml'), join('.pi', 'settings.json'), join('.pi', 'mcp.json'),
  join('.pi', 'APPEND_SYSTEM.md'), join('.pi', 'CAPABILITIES.md'), join('.pi', 'agents'), join('.pi', 'skills'), 'tools', join('data', 'knowledge', '.gitkeep')];
function isDefinition(rel) {
  if (rel.endsWith('.test.mjs')) return false;
  // Keep a path when it is, contains, or lies inside one of the definition paths.
  return DEFINITION.some(d => rel === d || d.startsWith(rel + sep) || rel.startsWith(d + sep));
}

/**
 * Copy the agent definition to <data>/agent/<version>/ and install its pinned
 * Pi packages there. Other versions' copies are removed. `log` reports steps.
 */
export function prepareAgent({ log = () => {}, force = false } = {}) {
  const target = installedAgentDir();
  if (!force && isReady(target)) { log(`Agent ${VERSION} is ready at ${target}`); return target; }
  const base = privateDir(join(toadDirs().data, 'agent'));
  const staging = join(base, `.staging-${VERSION}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  log(`Copying the agent to ${target}`);
  cpSync(TEMPLATE, staging, { recursive: true, dereference: false, filter: path => {
    const rel = relative(TEMPLATE, path);
    return !rel || (!lstatSync(path).isSymbolicLink() && isDefinition(rel));
  } });
  const settings = JSON.parse(readFileSync(join(staging, '.pi', 'settings.json'), 'utf8'));
  const piHome = join(staging, '.forge', 'pi-home');
  mkdirSync(piHome, { recursive: true, mode: 0o700 });
  const path = pathWithPi();
  for (const source of settings.packages ?? []) {
    log(`Installing ${source}`);
    const result = spawnSync('pi', ['install', source, '-l', '--approve'], {
      cwd: staging, encoding: 'utf8', timeout: 10 * 60 * 1000, shell: process.platform === 'win32',
      env: { ...process.env, [path.key]: path.value, PI_CODING_AGENT_DIR: piHome },
    });
    if (result.status !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`Could not install ${source}: ${(result.stderr || result.stdout || result.error?.message || '').trim().split('\n').filter(l => !l.startsWith('Warning')).slice(-3).join(' ')}`);
    }
  }
  if (!existsSync(join(staging, RUNNER))) { rmSync(staging, { recursive: true, force: true }); throw new Error('The Forge workflow runner was not installed'); }
  const chosen = readModels();
  if (chosen) {
    try { if (applyModels(staging, chosen)) log(`Using ${describeModels(chosen)}`); }
    catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  }
  writeFileSync(join(staging, READY), JSON.stringify({ version: VERSION, prepared: new Date().toISOString() }) + '\n');
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  // Other versions, and model variants of this one, which are rebuilt from it on demand.
  for (const entry of readdirSync(base)) if (entry !== VERSION) rmSync(join(base, entry), { recursive: true, force: true });
  rmSync(join(toadDirs().data, 'agent-variants'), { recursive: true, force: true });
  return target;
}

/**
 * The models a run uses, by precedence: `flags`, then the project's
 * toad.yaml, then what the agent runs on, which is the choice `toad setup`
 * applied to it (or the agent's defaults before any choice).
 */
export function resolveModels(agentDir, { flags = {}, project = {} } = {}) {
  const own = agentModels(agentDir);
  return {
    lead: flags.lead ?? project.lead ?? own.lead.model,
    tester: flags.tester ?? project.tester ?? own.testers[0]?.model ?? own.lead.model,
  };
}

/** Whether the agent already runs on `models`. */
export function runsOn(agentDir, models) {
  const { lead, testers } = agentModels(agentDir);
  return lead.model === models.lead && testers.every(t => t.model === models.tester);
}

/**
 * The agent to run on `models`: `agentDir` itself when it already uses them,
 * else a copy of it with the models applied, kept under
 * <data>/agent-variants/ and reused by later runs. The shared agent is never
 * changed, so a run with other models cannot affect runs in progress.
 */
export function agentFor(agentDir, models, { log = () => {} } = {}) {
  if (runsOn(agentDir, models)) return agentDir;
  let stamp = '';
  try { stamp = readFileSync(join(agentDir, READY), 'utf8'); } catch {}
  const key = createHash('sha256').update(JSON.stringify([agentDir, stamp, VERSION, models.lead, models.tester])).digest('hex').slice(0, 16);
  const base = privateDir(join(toadDirs().data, 'agent-variants'));
  const target = join(base, key);
  if (existsSync(join(target, READY)) && existsSync(join(target, RUNNER))) return target;
  log(`Preparing a copy of the agent for ${describeModels(models)}`);
  const staging = join(base, `.staging-${key}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  // Runtime state stays behind: sessions, locks and receipts belong to the original.
  const skip = [join('.pi', 'sessions'), join('.forge', 'workflow-locks'), join('.forge', 'pi-home', 'sessions'), join('data', 'receipts')];
  try {
    cpSync(agentDir, staging, { recursive: true, dereference: false, verbatimSymlinks: true, filter: path => !skip.includes(relative(agentDir, path)) });
    applyModels(staging, models);
    writeFileSync(join(staging, READY), JSON.stringify({ version: VERSION, from: agentDir, models, prepared: new Date().toISOString() }) + '\n');
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  try { renameSync(staging, target); }
  catch (error) {
    // Another run prepared the same variant first; use that one.
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(join(target, READY))) throw error;
  }
  return target;
}

/** The providers `models` use. */
export const providersOf = models => [...new Set([models.lead, models.tester].map(ref => String(ref).split('/')[0]))];

/**
 * The command that runs a workflow, equivalent to `./run --workflow …`: the
 * pinned Forge runner, the workflow manifest Forge generated into ./run, and
 * the orchestrator's appended prompts.
 */
export function workflowCommand(agentDir, args, piArgs = []) {
  const runner = join(agentDir, RUNNER);
  if (!existsSync(runner)) return { error: 'The agent is not set up. Run `toad setup`.' };
  let launcher = '';
  try { launcher = readFileSync(join(agentDir, 'run'), 'utf8'); } catch {}
  const manifest = /workflow-runner\.mjs" '([A-Za-z0-9+/=]+)'/.exec(launcher)?.[1];
  if (!manifest) return { error: `No workflow manifest in ${join(agentDir, 'run')}` };
  const prompts = ['APPEND_SYSTEM.md', 'CAPABILITIES.md'].filter(f => existsSync(join(agentDir, '.pi', f))).flatMap(f => ['--append-system-prompt', join('.pi', f)]);
  // Arguments before `--` reach Pi itself, after the appended prompts.
  return { command: process.execPath, args: [runner, manifest, ...prompts, ...piArgs, '--', ...args] };
}

/** Environment for a workflow: its own Pi home, the packaged `pi`, the stored model key. */
export function workflowEnv(agentDir, env) {
  const piHome = join(agentDir, '.forge', 'pi-home');
  mkdirSync(piHome, { recursive: true, mode: 0o700 });
  const path = pathWithPi(env);
  const out = { ...env, [path.key]: path.value, PI_CODING_AGENT_DIR: piHome };
  for (const [name, value] of Object.entries(readCredentials())) if (!out[name]) out[name] = value;
  return out;
}

const credentialsPath = () => join(toadDirs().config, 'credentials.json');

/** Model keys saved by `toad setup`, as environment variables. */
export function readCredentials() {
  let fd;
  try {
    fd = openSync(credentialsPath(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return {};
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    return Object.fromEntries(Object.entries(data ?? {}).filter(([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && typeof v === 'string' && v));
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function saveCredential(name, value) {
  const dir = privateDir(toadDirs().config);
  const data = { ...readCredentials(), [name]: value };
  const temp = join(dir, `.credentials-${process.pid}.json`);
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, credentialsPath());
}

const settingsPath = () => join(toadDirs().config, 'settings.json');

function readSettings() {
  try { const data = JSON.parse(readFileSync(settingsPath(), 'utf8')); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch { return {}; }
}

/** The models `toad setup` chose, as { lead, tester } `provider/id` references, or null before any choice. */
export function readModels() {
  const models = readSettings().models;
  const valid = ref => typeof ref === 'string' && /^[^/\s]+\/\S+$/.test(ref);
  return valid(models?.lead) && valid(models?.tester) ? { lead: models.lead, tester: models.tester } : null;
}

export function saveModels(models) {
  const dir = privateDir(toadDirs().config);
  const data = { ...readSettings(), models: { lead: models.lead, tester: models.tester } };
  const temp = join(dir, `.settings-${process.pid}.json`);
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, settingsPath());
}

export const describeModels = ({ lead, tester }) => (lead === tester ? lead : `${lead} (lead) and ${tester} (testers)`);

/** The models the agent's definition runs on: the orchestrator's (lead) and each tester's. */
export function agentModels(agentDir) {
  const system = YAML.parse(readFileSync(join(agentDir, '.pi', 'system.yaml'), 'utf8'));
  return {
    lead: { name: system.orchestrator.name, model: system.orchestrator.model },
    testers: (system.agents ?? []).map(agent => ({ name: agent.name, model: agent.model })),
  };
}

/**
 * Point the agent at `models` with Forge's validated `assign` change, which
 * also regenerates the files derived from system.yaml (the testers' agent
 * files and .pi/settings.json). Returns whether anything changed.
 */
export function applyModels(agentDir, models) {
  const current = agentModels(agentDir);
  const operations = [current.lead.model === models.lead ? null : { op: 'assign', name: current.lead.name, model: models.lead },
    ...current.testers.filter(t => t.model !== models.tester).map(t => ({ op: 'assign', name: t.name, model: models.tester }))].filter(Boolean);
  if (!operations.length) return false;
  const forge = join(agentDir, FORGE, 'forge.mjs');
  if (!existsSync(forge)) throw new Error(`Forge is not installed in ${agentDir}`);
  const file = join(privateDir(join(agentDir, '.forge')), `models-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(operations));
  try {
    const path = pathWithPi();
    const result = spawnSync(process.execPath, [forge, 'change', agentDir, '--operations', file, '--yes'], {
      cwd: agentDir, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [path.key]: path.value, PI_CODING_AGENT_DIR: join(agentDir, '.forge', 'pi-home') },
    });
    if (result.status !== 0) throw new Error(`Forge could not change the models: ${(result.stderr || result.stdout || result.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
  } finally { rmSync(file, { force: true }); }
  return true;
}

/**
 * For each provider the agent's models use, whether Pi, as a run would start
 * it, has credentials (a saved key, an inherited one, or a /login).
 */
export function modelReady(agentDir) {
  const { lead, testers } = agentModels(agentDir);
  const providers = [...new Set([lead.model, ...testers.map(t => t.model)].map(ref => String(ref).split('/')[0]))];
  return providers.map(provider => ({ provider, ready: providerReady(agentDir, provider) }));
}

/** Whether Pi, as a run would start it, has credentials for `provider`. */
export function providerReady(agentDir, provider, env = process.env) {
  return spawnSync('pi', ['auth', 'check', '--provider', provider, '--json', '--no-refresh'], {
    cwd: agentDir, env: workflowEnv(agentDir, env), encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32',
  }).status === 0;
}
