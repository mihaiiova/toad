/**
 * A machine-wide cap on concurrent test runs. Every MCP client starts its own
 * server process, so the cap is shared through slot files in the per-user
 * runtime directory: holding `slot-N` means holding a run slot. A slot whose
 * owner process has died is taken over.
 *
 * This is a resource limit, not a security boundary. Two servers reclaiming
 * the same dead slot at the same instant can briefly run one extra test.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';

export function slotLimit(env = process.env) {
  const value = Number(env.TOAD_MAX_CONCURRENT_RUNS ?? 2);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function read(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }

function tryTake(path, token) {
  try { writeFileSync(path, token, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const owner = read(path);
  const pid = Number(owner?.split(':')[0]);
  if (owner === null || (Number.isInteger(pid) && pid > 0 && alive(pid))) return false;
  // Re-check just before removing, so a slot someone else has just taken over is left alone.
  if (read(path) === owner) { try { unlinkSync(path); } catch {} }
  try { writeFileSync(path, token, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
}

/**
 * Wait for a free slot. Resolves with a release function, or with null when
 * `signal` aborts first. `onWait` is called each time a poll finds no slot.
 */
export async function acquireSlot({ signal, onWait, limit = slotLimit(), dir = join(toadDirs().runtime, 'slots'), pollMs = 500 } = {}) {
  privateDir(dir);
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    if (signal?.aborted) return null;
    for (let i = 0; i < limit; i++) {
      const path = join(dir, `slot-${i}`);
      if (tryTake(path, token)) return () => { if (read(path) === token) { try { unlinkSync(path); } catch {} } };
    }
    onWait?.();
    await new Promise(done => {
      const timer = setTimeout(finish, pollMs);
      function finish() { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); }
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}
