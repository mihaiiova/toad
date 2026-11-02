/**
 * Where TOaD keeps per-user state outside projects:
 *
 *   config   ~/.config/toad   the list of set-up projects
 *   cache    ~/.cache/toad    CLI scenario workspaces, pruned after a while
 *   runtime  $XDG_RUNTIME_DIR/toad (or a private folder in the system temp
 *            directory)         run slots and per-run secret files
 *
 * Each can be moved with TOAD_CONFIG_DIR, TOAD_CACHE_DIR or TOAD_RUNTIME_DIR.
 */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const uid = () => process.getuid?.() ?? 'user';

export function toadDirs(env = process.env) {
  const home = homedir();
  return {
    config: resolve(env.TOAD_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'toad')),
    cache: resolve(env.TOAD_CACHE_DIR || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'toad')),
    runtime: resolve(env.TOAD_RUNTIME_DIR || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'toad') : join(tmpdir(), `toad-${uid()}`))),
  };
}

/**
 * Create `path` (and its parents) if needed, then insist it is a real
 * directory owned by this user and closed to everyone else. The runtime
 * fallback lives in the shared temp directory, where another user could have
 * created the folder first.
 */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${path}`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`Not owned by this user: ${path}`);
  if (st.mode & 0o077) chmodSync(path, 0o700);
  return path;
}
