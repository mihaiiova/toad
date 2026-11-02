/**
 * Where the testing agent lives, how it is prepared, and how a workflow is
 * launched without the bash `run` script.
 *
 * The npm package ships the agent's definition (agent/). It is never run in
 * place: `toad setup` copies it to <data>/agent/<version>/ and installs its
 * pinned Pi packages there, so an update gets a fresh copy while the model key
 * stays in <config>/credentials.json. A git checkout whose agent/ has already
 * been set up with ./run is used in place, for development.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, closeSync, constants, fstatSync, openSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
const TEMPLATE = join(PACKAGE_ROOT, 'agent');
const RUNNER = join('.pi', 'git', 'github.com', 'mihaiiova', 'pi-forge', 'skills', 'forge', 'workflow-runner.mjs');
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
  writeFileSync(join(staging, READY), JSON.stringify({ version: VERSION, prepared: new Date().toISOString() }) + '\n');
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  for (const entry of readdirSync(base)) if (entry !== VERSION) rmSync(join(base, entry), { recursive: true, force: true });
  return target;
}

/**
 * The command that runs a workflow, equivalent to `./run --workflow …`: the
 * pinned Forge runner, the workflow manifest Forge generated into ./run, and
 * the orchestrator's appended prompts.
 */
export function workflowCommand(agentDir, args) {
  const runner = join(agentDir, RUNNER);
  if (!existsSync(runner)) return { error: 'The agent is not set up. Run `toad setup`.' };
  let launcher = '';
  try { launcher = readFileSync(join(agentDir, 'run'), 'utf8'); } catch {}
  const manifest = /workflow-runner\.mjs" '([A-Za-z0-9+/=]+)'/.exec(launcher)?.[1];
  if (!manifest) return { error: `No workflow manifest in ${join(agentDir, 'run')}` };
  const prompts = ['APPEND_SYSTEM.md', 'CAPABILITIES.md'].filter(f => existsSync(join(agentDir, '.pi', f))).flatMap(f => ['--append-system-prompt', join('.pi', f)]);
  return { command: process.execPath, args: [runner, manifest, ...prompts, '--', ...args] };
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

/** Whether Pi, as a run would start it, has a DeepSeek key (saved, inherited, or a /login). */
export function modelReady(agentDir) {
  const result = spawnSync('pi', ['auth', 'check', '--provider', 'deepseek', '--json', '--no-refresh'], {
    cwd: agentDir, env: workflowEnv(agentDir, process.env), encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32',
  });
  return result.status === 0;
}
