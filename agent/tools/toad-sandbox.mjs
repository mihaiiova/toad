/**
 * The CLI sandbox: a copied project workspace, and a way to run one command in
 * it. Two backends:
 *
 *   container  Docker or Podman, on any OS. The program runs in a Linux image
 *              (TOAD_CLI_IMAGE, default node:22-bookworm) with a read-only root
 *              filesystem, no capabilities and only the workspace writable.
 *   bwrap      Bubblewrap 0.8+ on Linux, with the host's /usr read-only.
 *   none       No isolation: commands run on the host, in the copied workspace,
 *              with a minimal environment. Only when TOAD_CLI_SANDBOX=none asks
 *              for it (CI runners without a container runtime); receipts say so.
 *
 * TOAD_CLI_SANDBOX picks one (container | bwrap | none); the default, auto,
 * prefers a running container runtime and falls back to Bubblewrap. There is
 * never a fallback to running on the host.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
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
/**
 * The environment for an unsandboxed command: the host's PATH (so its tools
 * are found), the workspace's home and the selected secrets, nothing else.
 */
export function hostEnv(workspace, secret = {}) {
  const keep = process.platform === 'win32' ? ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR'] : [];
  const kept = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k.toUpperCase())));
  return { ...kept, ...secret, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(workspace, 'home'), TMPDIR: join(workspace, 'tmp'), LANG: 'C.UTF-8', TOAD_SANDBOX: 'none' };
}
/** The shell an unsandboxed command runs in. */
export const hostShell = () => (process.platform === 'win32' ? 'sh' : '/bin/sh');

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
  if (!['auto', 'container', 'bwrap', 'none'].includes(wanted)) throw new Error(`Unknown TOAD_CLI_SANDBOX: ${wanted}`);
  if (wanted === 'none') return { sandbox: 'none' };
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
  if (sandbox.sandbox === 'none') {
    // The host's /usr is writable here; only the workspace itself is checked.
    const host = script === PREFLIGHT ? 'set -eu; printf ok > .toad-preflight; test "$(cat .toad-preflight)" = ok; rm .toad-preflight; test -w "$HOME"' : script;
    return spawnSync(hostShell(), ['-c', host, ...extra], { cwd: join(workspace, 'project'), env: hostEnv(workspace), encoding: 'utf8', timeout: 15000 });
  }
  return spawnSync('bwrap', sandboxArgs(workspace, ['/bin/sh', '-c', script, ...extra]), { env: sandboxEnv(), encoding: 'utf8', timeout: 15000 });
}

/** How a receipt and the lead describe a backend. */
export function describeSandbox(sandbox) {
  if (sandbox.sandbox === 'container') return `${sandbox.runtime} ${sandbox.image}`;
  if (sandbox.sandbox === 'none') return 'none (commands ran on the host, unsandboxed)';
  return 'bubblewrap';
}

/**
 * The workspace a run's setup commands prepared, when it was made from this
 * source: TOAD_BASE_SCENARIO names it. Scenarios then start from a copy of it
 * (project and home, symlinks kept as links) instead of the original project.
 */
function baseFor(source, env = process.env) {
  const id = env.TOAD_BASE_SCENARIO;
  if (!id) return null;
  const workspace = scenarioPath(null, id);
  let meta;
  try { meta = JSON.parse(readFileSync(join(workspace, 'metadata.json'), 'utf8')); } catch { throw new Error('The prepared setup workspace is unreadable'); }
  return meta.source === source ? workspace : null;
}

export function prepare(root, sourcePath, networkUrl) {
  const source = realpathSync(resolve(sourcePath));
  if (!statSync(source).isDirectory()) throw new Error('Project path must be a directory');
  if (networkUrl) { const u = new URL(networkUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Network preflight requires an HTTP(S) URL without credentials'); }
  const sandbox = chooseSandbox();
  if (sandbox.sandbox === 'container') ensureImage(sandbox);
  const prepared = baseFor(source);
  const base = privateDir(scenariosRoot());
  if (realpathSync(base) !== base) throw new Error('Scenario root must not contain symlinks');
  pruneScenarios(base);
  const id = randomUUID(), workspace = join(base, id);
  mkdirSync(workspace, { mode: 0o700 });
  try {
    const project = join(workspace, 'project');
    if (prepared) {
      // Already filtered when the setup workspace was made; its installs may
      // contain links (node_modules/.bin), which stay links inside the sandbox.
      cpSync(join(prepared, 'project'), project, { recursive: true, dereference: false, verbatimSymlinks: true });
      cpSync(join(prepared, 'home'), join(workspace, 'home'), { recursive: true, dereference: false, verbatimSymlinks: true });
    } else mkdirSync(join(workspace, 'home'), { mode: 0o700 });
    if (sandbox.sandbox === 'none') mkdirSync(join(workspace, 'tmp'), { recursive: true, mode: 0o700 });
    if (!prepared) cpSync(source, project, { recursive: true, dereference: false, filter: path => {
      const rel = relative(source, path);
      if (!rel) return true;
      const segments = rel.split(sep), name = segments.at(-1);
      if (lstatSync(path).isSymbolicLink()) return false;
      if (['.faur', '.forge', '.toad', '.git', '.ssh', '.aws', '.gnupg', '.kube', '.npmrc', '.pypirc', 'receipts', 'scenario-workspaces'].includes(name)) return false;
      if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || /\.(pem|key|p12|pfx)$/i.test(name)) return false;
      if (rel === join('.config', 'gcloud')) return false;
      if (resolve(path) === resolve(root, 'data/receipts')) return false;
      return true;
    } });
    const check = preflight(sandbox, workspace, PREFLIGHT);
    if (check.status !== 0) throw new Error(`Sandbox preflight failed${check.stderr ? `: ${check.stderr.trim().split('\n').at(-1)}` : ''}`);
    if (networkUrl) {
      // Reachability, not success: an API's base URL may well answer 401 or 404.
      const node = 'node -e "fetch(process.argv[1], {signal: AbortSignal.timeout(10000)}).catch(() => { process.exitCode=1 })" "$0"';
      const script = sandbox.sandbox !== 'bwrap'
        ? `if command -v node >/dev/null 2>&1; then ${node}; elif command -v curl >/dev/null 2>&1; then curl -sS -o /dev/null --max-time 10 "$0"; else wget -q -T 10 -O /dev/null "$0" || [ $? -eq 8 ]; fi`
        : `exec ${node}`;
      const network = preflight(sandbox, workspace, script, [networkUrl]);
      if (network.status !== 0) throw new Error('Sandbox network preflight failed');
    }
    writeFileSync(join(workspace, 'metadata.json'), JSON.stringify({ id, source, networkPreflight: networkUrl || null, sandbox, ...(prepared ? { from: basename(prepared) } : {}) }) + '\n', { mode: 0o600 });
    return { id, workspace, project, sandbox };
  } catch (error) { rmSync(workspace, { recursive: true, force: true }); throw error; }
}
