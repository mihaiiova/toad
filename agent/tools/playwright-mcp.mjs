#!/usr/bin/env node
/**
 * Starts the Playwright MCP server for the web-tester.
 *
 * Forge runs this integration in a trusted process environment. A wrapper run
 * names a per-run secrets file and receipts folder (inside the project's
 * .toad/runs/<id>/); direct and legacy runs keep the agent's own defaults.
 * The server starts inside the receipts folder, so a screenshot saved under a
 * relative name lands there too, never in the agent's folder.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.TOAD_RECEIPTS_DIR || join(root, 'data', 'receipts'));
const secrets = process.env.TOAD_PLAYWRIGHT_SECRETS_FILE || join(root, '.forge', 'test-secrets.env');
mkdirSync(out, { recursive: true });
const args = [...process.argv.slice(2), '--output-dir', out, ...(existsSync(secrets) ? ['--secrets', secrets] : [])];
// npx is a .cmd script on Windows; the arguments here are fixed, not user input.
const child = spawn('npx', args, { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(`playwright-mcp: ${error.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
