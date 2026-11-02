import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, toadDirs } from './toad-dirs.mjs';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function sandboxArgs(workspace, workload) {
  const project = join(workspace, 'project'), home = join(workspace, 'home');
  return ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net', '--new-session', '--die-with-parent',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/sbin', '/sbin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf', '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/pki', '/etc/pki',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', project, '/work', '--bind', home, '/home/tester', '--setenv', 'HOME', '/home/tester', '--setenv', 'TMPDIR', '/tmp', '--chdir', '/work', ...workload];
}
// These names can affect the host loader, Bubblewrap, or shell/runtime startup.
export function isReservedSecretName(name) {
  return /^(?:LD_.*|DYLD_.*|GCONV_PATH|GLIBC_TUNABLES|PATH|HOME|TMPDIR|LANG|LC_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT)$/i.test(name);
}
export function sandboxEnv(secret = {}) {
  return { ...secret, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}
// Workspaces live in the per-user cache, not in the TOaD install.
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
export function prepare(root, sourcePath, networkUrl) {
  const source = realpathSync(resolve(sourcePath));
  if (!statSync(source).isDirectory()) throw new Error('Project path must be a directory');
  if (networkUrl) { const u = new URL(networkUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Network preflight requires an HTTP(S) URL without credentials'); }
  const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== 'bubblewrap 0.12.0') throw new Error('Bubblewrap 0.12.0 is required');
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
    const check = spawnSync('bwrap', sandboxArgs(workspace, ['/bin/sh', '-c', 'set -eu; printf ok > /work/.toad-preflight; test "$(cat /work/.toad-preflight)" = ok; rm /work/.toad-preflight; test -w "$HOME"; test ! -w /usr']), { env: sandboxEnv(), encoding: 'utf8', timeout: 15000 });
    if (check.status !== 0) throw new Error('Sandbox preflight failed');
    if (networkUrl) {
      const network = spawnSync('bwrap', sandboxArgs(workspace, ['node', '-e', 'fetch(process.argv[1], {signal: AbortSignal.timeout(10000)}).then(r => { if (!r.ok) process.exitCode=1 }).catch(() => { process.exitCode=1 })', networkUrl]), { env: sandboxEnv(), encoding: 'utf8', timeout: 15000 });
      if (network.status !== 0) throw new Error('Sandbox network preflight failed');
    }
    writeFileSync(join(workspace, 'metadata.json'), JSON.stringify({ id, source, networkPreflight: networkUrl || null }) + '\n', { mode: 0o600 });
    return { id, workspace, project };
  } catch (error) { rmSync(workspace, { recursive: true, force: true }); throw error; }
}
