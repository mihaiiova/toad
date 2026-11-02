import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = resolve(import.meta.dirname, '../server.mjs');
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A stand-in for the Forge project: its `run` records the arguments, writes a
 * screenshot into the receipts folder it was given, and prints the result the
 * workflow runner would, as configured by `behaviour`.
 */
function agent(t, behaviour) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(behaviour));
  writeFileSync(join(dir, 'run'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync('args.json', JSON.stringify(args));
fs.writeFileSync('pid', String(process.pid));
const b = JSON.parse(fs.readFileSync('behaviour.json', 'utf8'));
const secretFile = process.env.TOAD_CLI_SECRETS_FILE || process.env.TOAD_PLAYWRIGHT_SECRETS_FILE;
if (secretFile) {
  fs.writeFileSync('secret-path', secretFile);
  fs.writeFileSync('secret-observed', fs.readFileSync(secretFile));
  fs.writeFileSync('capture-' + path.basename(path.dirname(secretFile)), fs.readFileSync(secretFile));
}
const receipts = args.find(a => a.startsWith('receipts=')).slice('receipts='.length);
fs.mkdirSync(receipts, { recursive: true });
fs.writeFileSync(path.join(receipts, 'scenario-01-home.png'), Buffer.from(${JSON.stringify(PNG)}, 'base64'));
fs.writeFileSync(path.join(receipts, 'scenario-02-help.txt'), '$ tool --help\\nexit: 0\\n');
if (b.nested) { fs.mkdirSync(path.join(receipts, 'scenario')); fs.writeFileSync(path.join(receipts, 'scenario', '01.txt'), 'nested evidence'); }
const finish = () => { console.log('pi output'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: b.status, answer: b.answer, toolErrors: 0, ...(b.cleanup ? {cleanup: b.cleanup} : {}) })); process.exit(b.code); };
process.on('SIGTERM', () => { fs.writeFileSync('cancelled', 'yes'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: 'cancelled', answer: '', toolErrors: 0 })); process.exit(1); });
setTimeout(finish, b.delay ?? 0);
`, { mode: 0o755 });
  return dir;
}

async function connect(t, dir) {
  const client = new Client({ name: 'toad-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, TOAD_AGENT_DIR: dir } }));
  t.after(() => client.close());
  return client;
}

test('coding agents can retrieve the skill as an MCP tool and resource', async t => {
  const client = await connect(t, agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 }));
  const skill = readFileSync(resolve(import.meta.dirname, '../../skills/toad-mcp/SKILL.md'), 'utf8');
  const result = await client.callTool({ name: 'get_toad_guide', arguments: {} });
  assert.equal(result.content[0].text, skill);
  const resources = await client.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === 'toad://guide'));
  const resource = await client.readResource({ uri: 'toad://guide' });
  assert.equal(resource.contents[0].text, skill);
  assert.match(client.getInstructions(), /get_toad_guide/);
});

test('project setup and handoff persist project-local evidence without overwriting files', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-project-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  const setup = () => client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  assert.notEqual((await setup()).isError, true);
  writeFileSync(join(project, '.toad', '.env'), 'PASSWORD=s3cr3t-sentinel\n');
  await setup();
  assert.equal(readFileSync(join(project, '.toad', '.env'), 'utf8'), 'PASSWORD=s3cr3t-sentinel\n');
  const viewerPath = join(project, '.toad', 'history.mjs');
  const viewer = readFileSync(viewerPath, 'utf8');
  assert.match(viewer, /^#!\/usr\/bin\/env node/);
  assert.match(viewer, /\/api\/runs/);
  assert.notEqual(statSync(viewerPath).mode & 0o100, 0);
  writeFileSync(viewerPath, 'sentinel-viewer\n');
  await setup();
  assert.equal(readFileSync(viewerPath, 'utf8'), 'sentinel-viewer\n');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'example' }, request: { goal: 'Check help' } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff, screenshots: 'paths' } });
  assert.equal(result.isError, false);
  const run = resolve(result.structuredContent.receipts, '..');
  assert.ok(run.startsWith(join(project, '.toad', 'runs') + '/'));
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'handoff.yaml'), 'utf8')), handoff);
  assert.match(readFileSync(join(run, 'reports', 'report.md'), 'utf8'), /PASS/);
  assert.ok(existsSync(result.structuredContent.screenshots[0]));
  const web = { version: 1, kind: 'web', target: { url: 'https://example.test' }, request: { goal: 'Check home' }, credentials: { password: { env: 'PASSWORD' } } };
  const resultWeb = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff: web } });
  assert.equal(resultWeb.isError, false);
  assert.ok(!JSON.stringify(resultWeb).includes('s3cr3t-sentinel'));
  assert.match(readFileSync(join(dir, 'secret-observed'), 'utf8'), /PASSWORD="s3cr3t-sentinel"/);
  assert.equal(existsSync(readFileSync(join(dir, 'secret-path'), 'utf8')), false);
});

test('web handoffs reject missing credentials and unsafe project paths', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-safe-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'web', target: { url: 'https://example.test' }, request: { goal: 'Check login' }, credentials: { password: { env: 'PASSWORD' } } };
  const missing = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing), /Missing referenced/);
  assert.equal(existsSync(join(dir, 'pid')), false);
  writeFileSync(join(project, '.toad', '.env'), 'PASSWORD=sentinel-value\n');
  const completed = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(completed.isError, false);
  assert.doesNotMatch(JSON.stringify(completed), /sentinel-value/);
  assert.equal(existsSync(join(dir, 'pid')), true);
  const alias = join(project, 'alias');
  symlinkSync(project, alias);
  const symlink = await client.callTool({ name: 'setup_project', arguments: { project_path: alias } });
  assert.equal(symlink.isError, true);
  const traversal = await client.callTool({ name: 'setup_project', arguments: { project_path: project + '/..' } });
  assert.equal(traversal.isError, true);
});

test('project runs collect nested scenario receipt files', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, nested: true });
  const project = mkdtempSync(join(tmpdir(), 'toad-nested-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test' }, request: { goal: 'Test' } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  const nested = result.structuredContent.files.find(f => f.endsWith('/scenario/01.txt'));
  assert.ok(nested);
  assert.equal(readFileSync(nested, 'utf8'), 'nested evidence');
});

test('project CLI handoffs select referenced credentials and empty selections exclude the shared store', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-cli-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'API_KEY=unique-secret-95\nOTHER=not-selected\n');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'example' }, request: { goal: 'Test' }, credentials: { api_key: { env: 'API_KEY' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secret-observed'), 'utf8')), { API_KEY: 'unique-secret-95' });
  assert.equal(existsSync(readFileSync(join(dir, 'secret-path'), 'utf8')), false);
  const run = resolve(result.structuredContent.receipts, '..');
  for (const text of [JSON.stringify(result), readFileSync(join(dir, 'args.json'), 'utf8'), readFileSync(join(run, 'handoff.yaml'), 'utf8'), readFileSync(join(run, 'reports', 'report.md'), 'utf8')]) assert.doesNotMatch(text, /unique-secret-95|not-selected/);
  delete handoff.credentials;
  const empty = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(empty.isError, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secret-observed'), 'utf8')), {});
  handoff.credentials = { bad: { env: 'NODE_OPTIONS' } };
  const reserved = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(reserved.isError, true); assert.match(JSON.stringify(reserved), /reserved/);
  handoff.credentials.bad.env = 'MISSING';
  const missing = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /Missing/);
});

test('MCP CLI run delivers only selected variables through the actual Bubblewrap recorder', async t => {
  const dir = agent(t, { status: 'ok', answer: 'unused', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-real-cli-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(dir, '.forge'));
  writeFileSync(join(dir, '.forge/test-secrets.env'), 'SHARED=should-not-reach-command\n');
  const recorder = resolve(import.meta.dirname, '../../agent/tools/toad-exec.mjs');
  writeFileSync(join(dir, 'run'), `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
const prep = spawnSync(process.execPath, [${JSON.stringify(recorder)}, 'prepare', ${JSON.stringify(project)}], { encoding: 'utf8' });
if (prep.status !== 0) { console.log(JSON.stringify({status:'error', message:prep.stderr, answer:''})); process.exit(1); }
const id = /Scenario ID: (.+)/.exec(prep.stdout)[1];
const receipts = args.find(a => a.startsWith('receipts=')).slice(9);
const run = spawnSync(process.execPath, [${JSON.stringify(recorder)}, 'run', receipts, 'env', id, 'printf "%s %s %s" "$API_KEY" "\u0024{SHARED-unset}" "\u0024{OTHER-unset}"'], { encoding: 'utf8' });
console.log(JSON.stringify({status:run.status === 0 ? 'ok' : 'error', answer:'Verdict: PASS\\n' + run.stdout, message:run.stderr}));
`, { mode: 0o755 });
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'API_KEY=test-sentinel-927\nOTHER=other-secret\n');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test' }, request: { goal: 'Check env' }, credentials: { key: { env: 'API_KEY' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(result.content[0].text, /\[secret:API_KEY\] unset unset/);
  const receipt = readFileSync(result.structuredContent.files.find(p => p.endsWith('/env.txt')), 'utf8');
  for (const text of [JSON.stringify(result), receipt]) assert.doesNotMatch(text, /test-sentinel-927|other-secret|should-not-reach-command/);
});

test('concurrent project CLI runs receive distinct selected sets', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, delay: 100 });
  const client = await connect(t, dir);
  const projects = [mkdtempSync(join(tmpdir(), 'toad-cli-a-')), mkdtempSync(join(tmpdir(), 'toad-cli-b-'))];
  t.after(() => projects.forEach(p => rmSync(p, { recursive: true, force: true })));
  for (const [i, project] of projects.entries()) {
    await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
    writeFileSync(join(project, '.toad', '.env'), `API_KEY=secret-${i}\nOTHER=not-selected\n`);
  }
  const results = await Promise.all(projects.map(project_path => client.callTool({ name: 'run_project_test', arguments: { project_path, handoff: { version: 1, kind: 'cli', target: { workdir: project_path, program: 'test' }, request: { goal: 'Test' }, credentials: { key: { env: 'API_KEY' } } } } })));
  assert.ok(results.every(result => !result.isError));
  const captures = readdirSync(dir).filter(name => name.startsWith('capture-')).map(name => readFileSync(join(dir, name), 'utf8')).sort();
  assert.deepEqual(captures, ['{"API_KEY":"secret-0"}', '{"API_KEY":"secret-1"}']);
});

test('cancelled project CLI runs stop before removing the credential file', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, delay: 30000 });
  const client = await connect(t, dir);
  const project = mkdtempSync(join(tmpdir(), 'toad-cli-cancel-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'API_KEY=cancel-test-secret\n');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test' }, request: { goal: 'Test' }, credentials: { key: { env: 'API_KEY' } } };
  const controller = new AbortController();
  const call = client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } }, undefined, { signal: controller.signal });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'secret-path')); i++) await new Promise(r => setTimeout(r, 20));
  const path = readFileSync(join(dir, 'secret-path'), 'utf8');
  assert.ok(existsSync(path));
  controller.abort(); await assert.rejects(call);
  for (let i = 0; i < 100 && (!existsSync(join(dir, 'cancelled')) || existsSync(path)); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(existsSync(join(dir, 'cancelled')));
  assert.equal(existsSync(path), false);
});

test('incomplete project CLI cleanup retains the per-run credentials', async t => {
  const dir = agent(t, { status: 'error', answer: '', code: 1, cleanup: 'incomplete' });
  const project = mkdtempSync(join(tmpdir(), 'toad-cli-incomplete-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'API_KEY=cleanup-test-secret\n');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test' }, request: { goal: 'Test' }, credentials: { key: { env: 'API_KEY' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  const path = readFileSync(join(dir, 'secret-path'), 'utf8');
  t.after(() => rmSync(resolve(path, '..'), { recursive: true, force: true }));
  assert.equal(result.isError, true); assert.ok(existsSync(path));
  assert.match(JSON.stringify(result), /Cleanup incomplete/);
  assert.doesNotMatch(JSON.stringify(result), /cleanup-test-secret/);
});

test('concurrent web runs select only their own project secrets', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, delay: 100 });
  const client = await connect(t, dir);
  const projects = [mkdtempSync(join(tmpdir(), 'toad-a-')), mkdtempSync(join(tmpdir(), 'toad-b-'))];
  t.after(() => projects.forEach(p => rmSync(p, { recursive: true, force: true })));
  for (const [i, project] of projects.entries()) {
    await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
    writeFileSync(join(project, '.toad', '.env'), `PASSWORD=secret-${i}\nUNUSED=not-selected\n`);
  }
  const handoff = { version: 1, kind: 'web', target: { url: 'https://example.test' }, request: { goal: 'Login' }, credentials: { password: { env: 'PASSWORD' } } };
  const results = await Promise.all(projects.map(project_path => client.callTool({ name: 'run_project_test', arguments: { project_path, handoff } })));
  assert.ok(results.every(result => !result.isError));
  const captures = readdirSync(dir).filter(name => name.startsWith('capture-')).map(name => readFileSync(join(dir, name), 'utf8')).sort();
  assert.deepEqual(captures, ['PASSWORD="secret-0"\n', 'PASSWORD="secret-1"\n']);
  assert.ok(results.every(result => !JSON.stringify(result).includes('secret-')));
});

test('selected secret is redacted from text results and report but absent from handoff and arguments', async t => {
  const secret = 'unique-sentinel-947';
  const dir = agent(t, { status: 'ok', answer: `Verdict: PASS\n${secret}`, code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-redact-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), `PASSWORD=${secret}\n`);
  const handoff = { version: 1, kind: 'web', target: { url: 'https://example.test' }, request: { goal: 'Login' }, credentials: { password: { env: 'PASSWORD' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff, screenshots: 'paths' } });
  const run = resolve(result.structuredContent.receipts, '..');
  for (const text of [JSON.stringify(result), readFileSync(join(run, 'handoff.yaml'), 'utf8'), readFileSync(join(run, 'reports', 'report.md'), 'utf8'), readFileSync(join(dir, 'args.json'), 'utf8')]) assert.ok(!text.includes(secret));
  assert.match(result.content[0].text, /\[REDACTED\]/);
});

test('incomplete Forge cleanup retains the secrets file and reports its directory', async t => {
  const dir = agent(t, { status: 'error', answer: '', code: 1, cleanup: 'incomplete' });
  const project = mkdtempSync(join(tmpdir(), 'toad-cleanup-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'PASSWORD=test-only-value\n');
  const handoff = { version: 1, kind: 'web', target: { url: 'https://example.test' }, request: { goal: 'Login' }, credentials: { password: { env: 'PASSWORD' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  const secretPath = readFileSync(join(dir, 'secret-path'), 'utf8');
  t.after(() => rmSync(resolve(secretPath, '..'), { recursive: true, force: true }));
  assert.equal(result.isError, true);
  assert.equal(existsSync(secretPath), true);
  assert.match(JSON.stringify(result), /Cleanup incomplete/);
  assert.doesNotMatch(JSON.stringify(result), /test-only-value/);
});

const report = verdict => `# Test report\n\n## Verdict\n\n${verdict}\n\nThe home page loads.\n\n## Scenarios\n\n**home — ${verdict}**`;

test('run_web_test runs the workflow and returns the verdict, report and screenshots', async t => {
  const dir = agent(t, { status: 'ok', answer: report('FAIL'), code: 0 });
  const client = await connect(t, dir);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_toad_guide', 'run_cli_test', 'run_project_test', 'run_web_test', 'setup_project']);
  const result = await client.callTool({ name: 'run_web_test', arguments: {
    url: 'https://staging.example.test', what: 'The home page',
    scenarios: [{ name: 'home', steps: 'Open the page', expected: 'The heading says Welcome' }],
    secrets: ['TEST_USER'], timeout_minutes: 5,
  } });
  assert.equal(result.isError, false, 'a failing test is a successful call');
  assert.equal(result.structuredContent.verdict, 'FAIL');
  assert.equal(result.structuredContent.status, 'ok');
  assert.match(result.content[0].text, /^Verdict: FAIL/);
  assert.match(result.content[0].text, /## Scenarios/);
  const image = result.content.find(c => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(result.structuredContent.screenshots.length, 1);
  assert.ok(existsSync(result.structuredContent.screenshots[0]), 'absolute paths callers can open');

  const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(0, 5), ['--workflow', 'test', '--timeout', '5m', '--allow-concurrent']);
  const request = args.find(a => a.startsWith('request=')).slice('request='.length);
  for (const part of ['https://staging.example.test', 'The home page', 'home', 'Open the page', 'The heading says Welcome', 'TEST_USER']) assert.ok(request.includes(part), part);
  assert.equal(args.find(a => a.startsWith('receipts=')), `receipts=${result.structuredContent.receipts}`);
  assert.match(result.structuredContent.receipts, new RegExp(`^${dir}/data/receipts/[0-9a-f-]{36}$`), 'absolute, and a folder per call, so parallel calls never mix receipts');
});

test('run_cli_test describes the program and working folder, and returns every receipt', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS\n\n## Scenarios', code: 0 });
  const client = await connect(t, dir);
  const result = await client.callTool({ name: 'run_cli_test', arguments: {
    workdir: '/srv/project', program: 'node apps/cli/dist/bin.js', what: 'The help output',
    scenarios: [{ name: 'help', steps: 'Run it with --help', expected: 'Exit code 0 and the commands are listed' }],
    secrets: ['API_KEY'],
  } });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.verdict, 'PASS');
  assert.deepEqual(result.structuredContent.files.map(f => f.split('/').at(-1)), ['scenario-01-home.png', 'scenario-02-help.txt']);
  assert.equal(result.content.some(c => c.type === 'image'), false, 'CLI tests attach no images');
  const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  const request = args.find(a => a.startsWith('request=')).slice('request='.length);
  for (const part of ['/srv/project', 'node apps/cli/dist/bin.js', 'The help output', 'Run it with --help', 'API_KEY']) assert.ok(request.includes(part), part);
  assert.match(request, /command-line program/);
});

test('runs that could not complete are tool errors with the runner message', async t => {
  const dir = agent(t, { status: 'timeout', answer: '', code: 4 });
  const client = await connect(t, dir);
  const result = await client.callTool({ name: 'run_web_test', arguments: { url: 'https://staging.example.test', what: 'Checkout' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'timeout');
  assert.match(result.content[0].text, /timeout/i);
});

test('the verdict is read whatever the heading level, and UNKNOWN when missing', async t => {
  for (const [answer, verdict] of [
    ['Verdict: FAIL\n\n## Scenarios', 'FAIL'],
    ['# Verdict\n\nERROR\n\nThe site was down.', 'ERROR'],
    ['### Verdict\n**PASS**', 'PASS'],
    ['**Verdict**\n\nFAIL\nScenario 2 failed.', 'FAIL'],
    ['**Verdict:** PASS', 'PASS'],
    ['All good.', 'UNKNOWN'],
    ['The verdict depends on the scenarios; one passed.', 'UNKNOWN'],
  ]) {
    const client = await connect(t, agent(t, { status: 'ok', answer, code: 0 }));
    const result = await client.callTool({ name: 'run_web_test', arguments: { url: 'https://staging.example.test', what: 'Home', screenshots: 'paths' } });
    assert.equal(result.structuredContent.verdict, verdict, answer);
  }
});

test('screenshots can be returned as paths only', async t => {
  const dir = agent(t, { status: 'ok', answer: report('PASS'), code: 0 });
  const client = await connect(t, dir);
  const result = await client.callTool({ name: 'run_web_test', arguments: { url: 'https://staging.example.test', what: 'Home', screenshots: 'paths' } });
  assert.equal(result.structuredContent.verdict, 'PASS');
  assert.equal(result.content.some(c => c.type === 'image'), false);
  assert.equal(result.structuredContent.screenshots.length, 1);
});

test('a cancelled call stops the workflow', async t => {
  const dir = agent(t, { status: 'ok', answer: report('PASS'), code: 0, delay: 30000 });
  const client = await connect(t, dir);
  const controller = new AbortController();
  const call = client.callTool({ name: 'run_web_test', arguments: { url: 'https://staging.example.test', what: 'Home' } }, undefined, { signal: controller.signal });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'pid')); i++) await new Promise(r => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(call);
  for (let i = 0; i < 100 && !existsSync(join(dir, 'cancelled')); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(existsSync(join(dir, 'cancelled')), 'the workflow received SIGTERM');
});
