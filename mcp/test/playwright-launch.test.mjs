import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
// Project paths must be canonical; on macOS the temp folder is behind a symlink.
const tmpdir = () => realpathSync(osTmpdir());
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = resolve(import.meta.dirname, '../../agent/tools/playwright-mcp.mjs');
const agentDir = resolve(import.meta.dirname, '../../agent');

/** Run the launcher with a fake npx that prints what it was given. */
function launch(t, extra) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npx'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
  delete env.TOAD_PLAYWRIGHT_SECRETS_FILE;
  delete env.TOAD_RECEIPTS_DIR;
  const result = spawnSync(process.execPath, [launcher, '-y', '@playwright/mcp@0.0.83', '--headless'], { env: { ...env, ...extra(dir) }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  return { ...out, flag: name => out.args.includes(name) ? out.args[out.args.indexOf(name) + 1] : undefined };
}

test('Playwright launcher passes its arguments and uses the per-run secrets file', t => {
  const run = launch(t, dir => { writeFileSync(join(dir, 'secrets.env'), ''); return { TOAD_PLAYWRIGHT_SECRETS_FILE: join(dir, 'secrets.env') }; });
  assert.deepEqual(run.args.slice(0, 3), ['-y', '@playwright/mcp@0.0.83', '--headless']);
  assert.match(run.flag('--secrets'), /secrets\.env$/);
});

test('Playwright launcher saves receipts in the run folder the wrapper names, and starts there', t => {
  let receipts;
  const run = launch(t, dir => ({ TOAD_RECEIPTS_DIR: (receipts = join(dir, 'project/.toad/runs/1/receipts')) }));
  assert.equal(run.flag('--output-dir'), receipts);
  assert.equal(run.cwd, receipts, 'relative screenshot names resolve inside the run folder');
});

test('Without a wrapper, the launcher keeps the agent defaults', t => {
  const run = launch(t, () => ({}));
  assert.equal(run.flag('--output-dir'), join(agentDir, 'data', 'receipts'));
});
