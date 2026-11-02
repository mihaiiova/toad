import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = resolve(import.meta.dirname, '../../agent/tools/playwright-mcp.sh');
const agentDir = resolve(import.meta.dirname, '../../agent');
test('Playwright launcher selects per-run file and preserves the legacy default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npx'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.TOAD_PLAYWRIGHT_SECRETS_FILE;
  delete env.TOAD_RECEIPTS_DIR;
  const call = extra => {
    const result = spawnSync('bash', [launcher, '-y', '@playwright/mcp@0.0.83', '--headless'], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(call({}).slice(-2), ['--secrets', join(agentDir, '.forge/test-secrets.env')]);
  assert.deepEqual(call({ TOAD_PLAYWRIGHT_SECRETS_FILE: '/tmp/selected/secrets.env' }).slice(-2), ['--secrets', '/tmp/selected/secrets.env']);
});

test('Playwright launcher saves receipts in the run folder the wrapper names', t => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npx'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.TOAD_RECEIPTS_DIR;
  const call = extra => JSON.parse(spawnSync('bash', [launcher, '-y', '@playwright/mcp@0.0.83'], { env: { ...env, ...extra }, encoding: 'utf8' }).stdout);
  const flag = ({ args }) => args[args.indexOf('--output-dir') + 1];
  assert.equal(flag(call({})), join(agentDir, 'data/receipts'));
  const receipts = join(dir, 'project/.toad/runs/1/receipts');
  const run = call({ TOAD_RECEIPTS_DIR: receipts });
  assert.equal(flag(run), receipts);
  assert.equal(run.cwd, receipts, 'relative screenshot names resolve inside the run folder');
});
