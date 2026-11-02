import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = resolve(import.meta.dirname, '../../agent/tools/playwright-mcp.sh');
test('Playwright launcher selects per-run file and preserves the legacy default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'revisor-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npx'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.REVISOR_PLAYWRIGHT_SECRETS_FILE;
  const call = extra => {
    const result = spawnSync('bash', [launcher, '-y', '@playwright/mcp@0.0.83', '--headless'], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(call({}).slice(-2), ['--secrets', '.forge/test-secrets.env']);
  assert.deepEqual(call({ REVISOR_PLAYWRIGHT_SECRETS_FILE: '/tmp/selected/secrets.env' }).slice(-2), ['--secrets', '/tmp/selected/secrets.env']);
});
