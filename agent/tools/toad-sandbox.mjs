/**
 * The CLI sandbox: a copied project workspace, and a way to run one command in
 * it. Two backends:
 *
 *   container  Docker or Podman, on any OS. The program runs in a Linux image
 *              (TOAD_CLI_IMAGE, default node:22-bookworm) with a read-only root
 *              filesystem, no capabilities and only the workspace writable.
 *   bwrap      Bubblewrap 0.8+ on Linux, with the host's /usr read-only.
 *
 * TOAD_CLI_SANDBOX picks one (container | bwrap); the default, auto, prefers a
 * running container runtime and falls back to Bubblewrap. There is never a
 * fallback to running on the host.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, toadDirs } from './toad-dirs.mjs';

export const DEFAULT_IMAGE = 'node:22-bookworm';
export const MIN_BWRAP = [0, 8, 0];
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFLIGHT = 'set -eu; printf ok > /work/.toad-preflight; test "$(cat /work/.toad-preflight)" = ok; rm /work/.toad-preflight; test -w "$HOME"; test ! -w /usr';

export function sandboxArgs(workspace, workload) {
  const project = join(workspace, 'project'), home = join(workspace, 'home');
  return ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net', '--new-session', '--die-with-parent',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/sbin', '/sbin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf', '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/pki', '/etc/pki',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', project, '/work', '--bind', home, '/home/tester', '--setenv', 'HOME', '/home/tester', '--setenv', 'TMPDIR', '/tmp', '--chdir', '/work', ...workload];
}
// These names can affect the host loader, Bubblewrap, the container CLI, or shell/runtime startup.
export function isReservedSecretName(name) {
  return /^(?:LD_.*|DYLD_.*|GCONV_PATH|GLIBC_TUNABLES|PATH|HOME|TMPDIR|LANG|LC_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|DOCKER_.*|CONTAINER_.*|CONTAINERS_.*|XDG_.*)$/i.test(name);
}
export function sandboxEnv(secret = {}) {
  return { ...secret, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}

/** A container runtime whose daemon (or machine) answers, or null. */
export function containerRuntime(env = process.env) {
  const candidates = env.TOAD_CONTAINER_RUNTIME ? [env.TOAD_CONTAINER_RUNTIME] : ['docker', 'podman'];
  for (const runtime of candidates) {
    if (!['docker', 'podman'].includes(runtime)) continue;
    const info = spawnSync(runtime, ['info', '--format', runtime === 'podman' ? '{{.Host.Security.Rootless}}' : '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000 });
    if (info.status === 0) return { runtime, rootless: runtime === 'podman' && info.stdout.trim() === 'true' };
  }
  return null;
}

/** The installed Bubblewrap version as [major, minor, patch], or null. */
export function bwrapVersion() {
  if (process.platform !== 'linux') return null;
  const result = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const match = /bubblewrap (\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? '');
  return result.status === 0 && match ? match.slice(1).map(Number) : null;
}
const atLeast = (version, min) => {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
};

/** Pick the backend for a new scenario, or explain why CLI tests cannot run. */
export function chooseSandbox(env = process.env) {
  const wanted = env.TOAD_CLI_SANDBOX || 'auto';
  if (!['auto', 'container', 'bwrap'].includes(wanted)) throw new Error(`Unknown TOAD_CLI_SANDBOX: ${wanted}`);
  if (wanted !== 'bwrap') {
    const container = containerRuntime(env);
    if (container) return { sandbox: 'container', ...container, image: env.TOAD_CLI_IMAGE || DEFAULT_IMAGE };
    if (wanted === 'container') throw new Error('No container runtime answered: start Docker or Podman');
  }
  const version = bwrapVersion();
  if (version && atLeast(version, MIN_BWRAP)) return { sandbox: 'bwrap' };
  if (wanted === 'bwrap') throw new Error(version ? `Bubblewrap ${MIN_BWRAP.join('.')} or later is required (found ${version.join('.')})` : 'Bubblewrap is not installed');
  throw new Error(`CLI tests need Docker or Podman running${process.platform === 'linux' ? `, or Bubblewrap ${MIN_BWRAP.join('.')}+` : ''}`);
}

/**
 * The container runtime arguments for one command. Secrets reach the container
 * through an env file, never the command line.
 */
export function containerArgs({ runtime, rootless, image }, workspace, { name, envFile, interactive = false }, workload) {
  const user = runtime === 'podman' && rootless ? ['--userns=keep-id']
    : ['--user', process.platform === 'linux' ? `${process.getuid()}:${process.getgid()}` : '1000:1000'];
  return ['run', '--rm', '--name', name, ...(interactive ? ['-i'] : []),
    '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '1024',
    ...user,
    // Docker Desktop provides this name already; on Linux it needs mapping.
    ...(runtime === 'docker' && process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '-v', `${join(workspace, 'project')}:/work`, '-v', `${join(workspace, 'home')}:/home/tester`, '-w', '/work',
    '-e', 'HOME=/home/tester', '-e', 'TMPDIR=/tmp', '-e', 'LANG=C.UTF-8',
    ...(envFile ? ['--env-file', envFile] : []),
    '--entrypoint', '/bin/sh', image, '-c', ...workload];
}

// Workspaces live in the per-user cache, not in the Toad install.
export function scenariosRoot() { return join(toadDirs().cache, 'scenarios'); }
const DAY = 24 * 60 * 60 * 1000;
/** Remove workspaces untouched for TOAD_SCENARIO_TTL_DAYS (default 7; 0 keeps them). */
export function pruneScenarios(base = scenariosRoot(), now = Date.now()) {
  const days = Number(process.env.TOAD_SCENARIO_TTL_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return [];
  const removed = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const path = join(base, entry.name);
    try {
      if (now - lstatSync(path).mtimeMs < days * DAY) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* in use or already gone */ }
  }
  return removed;
}
export function scenarioPath(root, id) {
  if (!idPattern.test(id)) throw new Error('Invalid scenario ID');
  const base = scenariosRoot(), path = join(base, id);
  if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Scenario ID not found or unsafe');
  for (const child of ['project', 'home']) if (!lstatSync(join(path, child)).isDirectory()) throw new Error('Scenario workspace is unsafe');
  return path;
}
/** The backend a prepared scenario was set up with. */
export function scenarioSandbox(workspace) {
  try { return JSON.parse(readFileSync(join(workspace, 'metadata.json'), 'utf8')).sandbox ?? { sandbox: 'bwrap' }; }
  catch { return { sandbox: 'bwrap' }; }
}

function ensureImage({ runtime, image }) {
  if (spawnSync(runtime, ['image', 'inspect', image], { stdio: 'ignore', timeout: 30000 }).status === 0) return;
  const pull = spawnSync(runtime, ['pull', image], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
  if (pull.status !== 0) throw new Error(`Could not pull the image ${image}: ${(pull.stderr || '').trim().split('\n').at(-1)}`);
}

function preflight(sandbox, workspace, script, extra = []) {
  if (sandbox.sandbox === 'container') {
    const name = `toad-preflight-${randomUUID()}`;
    const result = spawnSync(sandbox.runtime, containerArgs(sandbox, workspace, { name }, [script, ...extra]), { encoding: 'utf8', timeout: 60000 });
    if (result.status === null) spawnSync(sandbox.runtime, ['kill', name], { stdio: 'ignore', timeout: 15000 });
    return result;
  }
  return spawnSync('bwrap', sandboxArgs(workspace, ['/bin/sh', '-c', script, ...extra]), { env: sandboxEnv(), encoding: 'utf8', timeout: 15000 });
}

export function prepare(root, sourcePath, networkUrl) {
  const source = realpathSync(resolve(sourcePath));
  if (!statSync(source).isDirectory()) throw new Error('Project path must be a directory');
  if (networkUrl) { const u = new URL(networkUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Network preflight requires an HTTP(S) URL without credentials'); }
  const sandbox = chooseSandbox();
  if (sandbox.sandbox === 'container') ensureImage(sandbox);
  const base = privateDir(scenariosRoot());
  if (realpathSync(base) !== base) throw new Error('Scenario root must not contain symlinks');
  pruneScenarios(base);
  const id = randomUUID(), workspace = join(base, id);
  mkdirSync(workspace, { mode: 0o700 });
  try {
    const project = join(workspace, 'project');
    mkdirSync(join(workspace, 'home'), { mode: 0o700 });
    cpSync(source, project, { recursive: true, dereference: false, filter: path => {
      const rel = relative(source, path);
      if (!rel) return true;
      const segments = rel.split(sep), name = segments.at(-1);
      if (lstatSync(path).isSymbolicLink()) return false;
      if (['.forge', '.toad', '.git', '.ssh', '.aws', '.gnupg', '.kube', '.npmrc', '.pypirc', 'receipts', 'scenario-workspaces'].includes(name)) return false;
      if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || /\.(pem|key|p12|pfx)$/i.test(name)) return false;
      if (rel === join('.config', 'gcloud')) return false;
      if (resolve(path) === resolve(root, 'data/receipts')) return false;
      return true;
    } });
    const check = preflight(sandbox, workspace, PREFLIGHT);
    if (check.status !== 0) throw new Error(`Sandbox preflight failed${check.stderr ? `: ${check.stderr.trim().split('\n').at(-1)}` : ''}`);
    if (networkUrl) {
      const script = sandbox.sandbox === 'container'
        ? 'if command -v node >/dev/null 2>&1; then node -e "fetch(process.argv[1], {signal: AbortSignal.timeout(10000)}).then(r => { if (!r.ok) process.exitCode=1 }).catch(() => { process.exitCode=1 })" "$0"; elif command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null --max-time 10 "$0"; else wget -q -T 10 -O /dev/null "$0"; fi'
        : 'exec node -e "fetch(process.argv[1], {signal: AbortSignal.timeout(10000)}).then(r => { if (!r.ok) process.exitCode=1 }).catch(() => { process.exitCode=1 })" "$0"';
      const network = preflight(sandbox, workspace, script, [networkUrl]);
      if (network.status !== 0) throw new Error('Sandbox network preflight failed');
    }
    writeFileSync(join(workspace, 'metadata.json'), JSON.stringify({ id, source, networkPreflight: networkUrl || null, sandbox }) + '\n', { mode: 0o600 });
    return { id, workspace, project, sandbox };
  } catch (error) { rmSync(workspace, { recursive: true, force: true }); throw error; }
}
