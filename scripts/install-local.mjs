#!/usr/bin/env node
/**
 * Install Toad from a local checkout the way npm would from the registry:
 * pack the folder into the same tarball `npm publish` would upload, then
 * install that tarball globally. The result is a real copy, not a link back
 * to the checkout.
 *
 *   node scripts/install-local.mjs [checkout]   # default: this checkout
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function installLocal(checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const shell = process.platform === 'win32';
  const out = mkdtempSync(join(tmpdir(), 'toad-pack-'));
  try {
    const pack = spawnSync('npm', ['pack', '--pack-destination', out], { cwd: checkout, encoding: 'utf8', shell });
    if (pack.status !== 0) throw new Error(`npm pack failed in ${checkout}: ${pack.stderr.trim().split('\n').at(-1)}`);
    const tarball = join(out, readdirSync(out).find(name => name.endsWith('.tgz')));
    console.log(`Installing ${tarball}`);
    const install = spawnSync('npm', ['install', '--global', tarball], { stdio: 'inherit', shell });
    if (install.status !== 0) throw new Error('npm install failed');
  } finally { rmSync(out, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installLocal(process.argv[2] ? resolve(process.argv[2]) : undefined); console.log('Installed. Next: toad setup'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
