import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
// Project paths must be canonical; on macOS the temp folder is behind a symlink.
const tmpdir = () => realpathSync(osTmpdir());
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chooseSandbox } from '../../agent/tools/toad-sandbox.mjs';

const server = resolve(import.meta.dirname, '../server.mjs');
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A stand-in for the Forge project: its `run` records the arguments, writes a
 * screenshot into the receipts folder it was given, and prints the result the
 * workflow runner would, as configured by `behaviour`.
 */
const RUNNER = '.pi/git/github.com/mihaiiova/pi-forge/skills/forge/workflow-runner.mjs';
/** Install `code` as the agent's workflow runner, launched the way ./run would. */
function standIn(dir, code) {
  mkdirSync(join(dir, dirname(RUNNER)), { recursive: true });
  writeFileSync(join(dir, RUNNER), code);
  const manifest = Buffer.from(JSON.stringify([{ name: 'test', entry: 'lead', lead: 'lead' }])).toString('base64');
  writeFileSync(join(dir, 'run'), `exec node "$ROOT/${RUNNER}" '${manifest}' "\${prompts[@]}" -- "$@"\n`);
}

function agent(t, behaviour) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(behaviour));
  standIn(dir, `import fs from 'node:fs'; import path from 'node:path';
const all = process.argv.slice(2);
const args = all.slice(all.indexOf('--') + 1);
fs.writeFileSync('launch.json', JSON.stringify({ all, piHome: process.env.PI_CODING_AGENT_DIR }));
fs.writeFileSync('args.json', JSON.stringify(args));
fs.writeFileSync('pid', String(process.pid));
fs.writeFileSync('receipts-env', process.env.TOAD_RECEIPTS_DIR || '');
fs.appendFileSync('spans', JSON.stringify({ start: Date.now() }) + '\\n');
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
const finish = () => { fs.appendFileSync('spans', JSON.stringify({ end: Date.now() }) + '\\n'); console.log('pi output'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: b.status, answer: b.answer, toolErrors: 0, ...(b.cleanup ? {cleanup: b.cleanup} : {}) })); process.exit(b.code); };
process.on('SIGTERM', () => { fs.writeFileSync('cancelled', 'yes'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: 'cancelled', answer: '', toolErrors: 0 })); process.exit(1); });
setTimeout(finish, b.delay ?? 0);
`);
  return dir;
}

/** Per-user state (project list, cache, run slots, secret files) for one test. */
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { TOAD_CONFIG_DIR: join(dir, 'config'), TOAD_CACHE_DIR: join(dir, 'cache'), TOAD_RUNTIME_DIR: join(dir, 'runtime') };
}

async function connect(t, dir, env = home(t)) {
  const client = new Client({ name: 'toad-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, TOAD_AGENT_DIR: dir, ...env } }));
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
  const env = home(t);
  const client = await connect(t, dir, env);
  const setup = () => client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const first = await setup();
  assert.notEqual(first.isError, true);
  assert.match(first.content[0].text, /cli\.mjs ui/);
  writeFileSync(join(project, '.toad', '.env'), 'PASSWORD=s3cr3t-sentinel\n');
  await setup();
  assert.equal(readFileSync(join(project, '.toad', '.env'), 'utf8'), 'PASSWORD=s3cr3t-sentinel\n');
  assert.equal(existsSync(join(project, '.toad', 'history.mjs')), false, 'the viewer is no longer copied into projects');
  const configPath = join(project, '.toad', 'toad.yaml');
  assert.match(readFileSync(configPath, 'utf8'), /# web:/);
  writeFileSync(configPath, '# mine\n');
  await setup();
  assert.equal(readFileSync(configPath, 'utf8'), '# mine\n');
  const listed = JSON.parse(readFileSync(join(env.TOAD_CONFIG_DIR, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(listed.map(p => p.path), [project], 'set up once, listed once');
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'example' }, request: { goal: 'Check help' } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff, screenshots: 'paths' } });
  assert.equal(result.isError, false);
  const run = resolve(result.structuredContent.receipts, '..');
  assert.ok(run.startsWith(join(project, '.toad', 'runs') + '/'));
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'handoff.yaml'), 'utf8')), handoff);
  assert.match(readFileSync(join(run, 'reports', 'report.md'), 'utf8'), /PASS/);
  assert.ok(existsSync(result.structuredContent.screenshots[0]));
  const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.equal(args.find(a => a.startsWith('receipts=')), `receipts=${join(run, 'receipts')}`, 'receipts are written straight into the project');
  assert.equal(existsSync(join(dir, 'data', 'receipts')), false, 'no global copy');
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

test('API handoffs take defaults from toad.yaml, run in the CLI sandbox and map localhost for containers', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-api-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', 'toad.yaml'), 'api:\n  url: http://localhost:8080/api\n  spec: openapi.yaml\n');
  writeFileSync(join(project, '.toad', '.env'), 'API_TOKEN=api-secret-731\n');
  const handoff = { version: 1, kind: 'api', request: { goal: 'Check orders', scenarios: [{ name: 'No token', steps: 'GET /orders without a token', expected: '401' }] }, credentials: { token: { env: 'API_TOKEN' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, false);
  const text = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')).find(a => a.startsWith('request='));
  assert.match(text, /Test the HTTP API at http:\/\/localhost:8080\/api\./);
  assert.match(text, new RegExp(`with the API's description and test fixtures: ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), 'workdir defaults to the project');
  assert.match(text, /The OpenAPI description is openapi\.yaml/);
  assert.match(text, /Use each env name as a shell environment variable/);
  let container = false;
  try { container = chooseSandbox().sandbox === 'container'; } catch {}
  if (container) assert.match(text, /use http:\/\/host\.docker\.internal:8080\/api instead/);
  else assert.doesNotMatch(text, /host\.docker\.internal/);
  // Secrets reach the sandbox as variables (JSON), as for CLI runs, never the call or the records.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secret-observed'), 'utf8')), { API_TOKEN: 'api-secret-731' });
  const run = resolve(result.structuredContent.receipts, '..');
  for (const record of [JSON.stringify(result), text, readFileSync(join(run, 'handoff.yaml'), 'utf8')]) assert.doesNotMatch(record, /api-secret-731/);
  assert.equal(JSON.parse(readFileSync(join(run, 'handoff.yaml'), 'utf8')).target.workdir, project);

  writeFileSync(join(project, '.toad', 'toad.yaml'), '# no defaults\n');
  const missing = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /API handoff requires target\.url/);
  const reserved = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff: { ...handoff, target: { url: 'https://api.example.test' }, credentials: { bad: { env: 'NODE_OPTIONS' } } } } });
  assert.equal(reserved.isError, true); assert.match(JSON.stringify(reserved), /reserved/);
});

let sandboxAvailable = true;
try { chooseSandbox(); } catch { sandboxAvailable = false; }
test('MCP CLI run delivers only selected variables through the actual sandboxed recorder', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, async t => {
  const dir = agent(t, { status: 'ok', answer: 'unused', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-real-cli-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(dir, '.forge'));
  writeFileSync(join(dir, '.forge/test-secrets.env'), 'SHARED=should-not-reach-command\n');
  const recorder = resolve(import.meta.dirname, '../../agent/tools/toad-exec.mjs');
  standIn(dir, `import { spawnSync } from 'node:child_process';
const all = process.argv.slice(2);
const args = all.slice(all.indexOf('--') + 1);
const prep = spawnSync(process.execPath, [${JSON.stringify(recorder)}, 'prepare', ${JSON.stringify(project)}], { encoding: 'utf8' });
if (prep.status !== 0) { console.log(JSON.stringify({status:'error', message:prep.stderr, answer:''})); process.exit(1); }
const id = /Scenario ID: (.+)/.exec(prep.stdout)[1];
const receipts = args.find(a => a.startsWith('receipts=')).slice(9);
const run = spawnSync(process.execPath, [${JSON.stringify(recorder)}, 'run', receipts, 'env', id, 'printf "%s %s %s" "$API_KEY" "\u0024{SHARED-unset}" "\u0024{OTHER-unset}"'], { encoding: 'utf8' });
console.log(JSON.stringify({status:run.status === 0 ? 'ok' : 'error', answer:'Verdict: PASS\\n' + run.stdout, message:run.stderr}));
`);
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'API_KEY=test-sentinel-927\nOTHER=other-secret\n');
  // A small image that is commonly present; the handoff picks it per project.
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test', image: process.env.TOAD_TEST_IMAGE || 'node:22-slim' }, request: { goal: 'Check env' }, credentials: { key: { env: 'API_KEY' } } };
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

test('project defaults in toad.yaml fill in what a handoff leaves out', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-defaults-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', 'toad.yaml'), 'web:\n  url: http://localhost:3000\ncli:\n  workdir: apps/cli\n  program: node dist/bin.js\ntimeout_minutes: 7\n');
  const web = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff: { version: 1, kind: 'web', request: { goal: 'Home' } }, screenshots: 'paths' } });
  assert.equal(web.isError, false, JSON.stringify(web));
  let args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--timeout') + 1], '7m');
  assert.match(args.find(a => a.startsWith('request=')), /Test http:\/\/localhost:3000\./);
  const run = resolve(web.structuredContent.receipts, '..');
  assert.equal(JSON.parse(readFileSync(join(run, 'handoff.yaml'), 'utf8')).target.url, 'http://localhost:3000', 'the effective handoff is recorded');
  assert.equal(readFileSync(join(dir, 'receipts-env'), 'utf8'), join(run, 'receipts'));
  const cli = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff: { version: 1, kind: 'cli', target: { program: 'other' }, request: { goal: 'Help' } }, timeout_minutes: 3 } });
  assert.equal(cli.isError, false);
  args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--timeout') + 1], '3m', 'the call overrides the default');
  const request = args.find(a => a.startsWith('request=')).slice('request='.length);
  assert.ok(request.includes(`working folder ${join(project, 'apps/cli')}`), request);
  assert.ok(request.includes('Invoke it as: other'), 'the handoff overrides the default');
});

test('an invalid toad.yaml is reported before anything runs', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-badconfig-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'web', request: { goal: 'Home' } };
  const missing = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /web\.url in \.toad\/toad\.yaml/);
  writeFileSync(join(project, '.toad', 'toad.yaml'), 'web:\n  adress: http://x\n');
  const typo = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(typo.isError, true); assert.match(JSON.stringify(typo), /toad\.yaml/);
  writeFileSync(join(project, '.toad', 'toad.yaml'), 'web: [\n');
  const broken = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(broken.isError, true); assert.match(JSON.stringify(broken), /not valid YAML/);
  assert.equal(existsSync(join(dir, 'pid')), false);
});

test('runs from separate servers share the machine-wide slot limit', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, delay: 300 });
  const env = { ...home(t), TOAD_MAX_CONCURRENT_RUNS: '1' };
  const clients = [await connect(t, dir, env), await connect(t, dir, env)];
  const call = client => client.callTool({ name: 'run_web_test', arguments: { url: 'https://example.test', what: 'Home', screenshots: 'paths' } });
  const results = await Promise.all([call(clients[0]), call(clients[1]), call(clients[0])]);
  assert.ok(results.every(r => !r.isError));
  // With one slot, every run must end before the next one starts.
  let running = 0, peak = 0;
  for (const line of readFileSync(join(dir, 'spans'), 'utf8').trim().split('\n')) {
    running += JSON.parse(line).start ? 1 : -1;
    peak = Math.max(peak, running);
  }
  assert.equal(peak, 1);
});

test('a call cancelled while waiting for a slot never starts', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0, delay: 2000 });
  const env = { ...home(t), TOAD_MAX_CONCURRENT_RUNS: '1' };
  const client = await connect(t, dir, env);
  const first = client.callTool({ name: 'run_web_test', arguments: { url: 'https://example.test', what: 'Home', screenshots: 'paths' } });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'pid')); i++) await new Promise(r => setTimeout(r, 20));
  const controller = new AbortController();
  const second = client.callTool({ name: 'run_web_test', arguments: { url: 'https://example.test', what: 'Other', screenshots: 'paths' } }, undefined, { signal: controller.signal });
  await new Promise(r => setTimeout(r, 200));
  controller.abort(); await assert.rejects(second);
  assert.equal((await first).isError, false);
  const starts = readFileSync(join(dir, 'spans'), 'utf8').trim().split('\n').filter(line => JSON.parse(line).start);
  assert.equal(starts.length, 1);
});

test('the agent runs through the Forge runner with its own Pi home, without ./run', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const client = await connect(t, dir);
  await client.callTool({ name: 'run_web_test', arguments: { url: 'https://example.test', what: 'Home', screenshots: 'paths' } });
  const launch = JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8'));
  assert.equal(launch.piHome, join(dir, '.forge', 'pi-home'));
  assert.equal(launch.all[0], Buffer.from(JSON.stringify([{ name: 'test', entry: 'lead', lead: 'lead' }])).toString('base64'));
  assert.deepEqual(launch.all.slice(launch.all.indexOf('--') + 1, launch.all.indexOf('--') + 3), ['--workflow', 'test']);
});

test('an agent that is not set up is a clear error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-empty-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = await connect(t, dir);
  const result = await client.callTool({ name: 'run_web_test', arguments: { url: 'https://example.test', what: 'Home' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /toad setup/);
});

/** Give a stand-in agent the real sandbox tools, as the prepared agent has. */
function realTools(dir) {
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const name of ['toad-exec.mjs', 'toad-sandbox.mjs', 'toad-dirs.mjs']) writeFileSync(join(dir, 'tools', name), readFileSync(resolve(import.meta.dirname, '../../agent/tools', name)));
}

test('setup runs once in the sandbox and every scenario starts from its result', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, async t => {
  const dir = agent(t, { status: 'ok', answer: 'unused', code: 0 });
  realTools(dir);
  const project = mkdtempSync(join(tmpdir(), 'toad-setup-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  standIn(dir, `import { spawnSync } from 'node:child_process';
const all = process.argv.slice(2);
const args = all.slice(all.indexOf('--') + 1);
const request = args.find(a => a.startsWith('request=')).slice(8);
const prep = spawnSync(process.execPath, ['tools/toad-exec.mjs', 'prepare', ${JSON.stringify(project)}], { encoding: 'utf8' });
const id = /Scenario ID: (.+)/.exec(prep.stdout)[1];
const receipts = args.find(a => a.startsWith('receipts=')).slice(9);
const run = spawnSync(process.execPath, ['tools/toad-exec.mjs', 'run', receipts + '/uses-the-tool', '01-tool', id, 'cat installed.txt'], { encoding: 'utf8' });
const ok = /installed by setup/.test(run.stdout) && /Setup already ran/.test(request) && /not allowed/.test(request);
console.log(JSON.stringify({ status: 'ok', answer: 'Verdict: ' + (ok ? 'PASS' : 'FAIL') + '\\nResults:\\n- ' + (ok ? 'PASS' : 'FAIL') + ' | Uses the tool\\n' }));
`);
  const env = home(t);
  const client = await connect(t, dir, env);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test', image: process.env.TOAD_TEST_IMAGE || 'node:22-slim', setup: ['echo installed by setup > installed.txt'] },
    request: { goal: 'Check setup', scenarios: [{ name: 'Uses the tool', steps: 'cat installed.txt', expected: 'the text' }] } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.verdict, 'PASS');
  assert.deepEqual(result.structuredContent.scenarios, [{ name: 'Uses the tool', result: 'PASS' }]);
  assert.match(readFileSync(result.structuredContent.files.find(p => p.endsWith('/setup/01-setup.txt')), 'utf8'), /result: exit 0/);
  assert.equal(existsSync(join(project, 'installed.txt')), false);
  // Only the scenario's own workspace is left; the setup workspace is removed.
  assert.equal(readdirSync(join(env.TOAD_CACHE_DIR, 'scenarios')).length, 1);
});

test('a failed setup ends the run as ERROR before any scenario starts', { skip: !sandboxAvailable && 'no CLI sandbox on this machine' }, async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  realTools(dir);
  const project = mkdtempSync(join(tmpdir(), 'toad-setup-fail-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test', image: process.env.TOAD_TEST_IMAGE || 'node:22-slim', setup: ['true', 'echo no such package >&2; exit 4'] },
    request: { goal: 'Check', scenarios: [{ name: 'A', steps: 's', expected: 'e' }, { name: 'B', steps: 's', expected: 'e' }] } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'setup_failed');
  assert.equal(result.structuredContent.verdict, 'ERROR');
  assert.deepEqual(result.structuredContent.scenarios.map(s => s.result), ['ERROR', 'ERROR']);
  assert.match(result.content[0].text, /exit 4/);
  assert.equal(existsSync(join(dir, 'launch.json')), false, 'the workflow never started');
  assert.match(readFileSync(result.structuredContent.files.find(p => p.endsWith('/setup/02-setup.txt')), 'utf8'), /no such package/);
});

test('scenario results come back by name, and a contradicting verdict is corrected', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Compiling the report.\nVerdict: PASS\nResults:\n- PASS | A\n- ERROR | B\n', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-results-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'cli', target: { workdir: project, program: 'test' },
    request: { goal: 'Check', scenarios: ['A', 'B', 'C'].map(name => ({ name, steps: 's', expected: 'e' })) } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.structuredContent.verdict, 'ERROR');
  assert.deepEqual(result.structuredContent.scenarios, [{ name: 'A', result: 'PASS' }, { name: 'B', result: 'ERROR' }, { name: 'C', result: 'ERROR', missing: true }]);
  const runs = join(project, '.toad', 'runs');
  const run = join(runs, readdirSync(runs)[0]);
  assert.match(readFileSync(join(run, 'reports', 'report.md'), 'utf8'), /^# Toad run\n\nStatus: ok\n\nVerdict: ERROR\n\n\(The report said PASS/);
  assert.equal(JSON.parse(readFileSync(join(run, 'state.json'), 'utf8')).scenarios.length, 3);
});

test('a project run that cannot start is recorded as failed, not left running', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-nostart-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  // The per-run secrets folder cannot be made: its parent is a file.
  const env = home(t);
  mkdirSync(dirname(env.TOAD_RUNTIME_DIR), { recursive: true });
  writeFileSync(env.TOAD_RUNTIME_DIR, 'not a folder');
  const client = await connect(t, dir, env);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  writeFileSync(join(project, '.toad', '.env'), 'TOAD_TEST_EMAIL=a@example.test\n');
  const handoff = { version: 1, kind: 'web', target: { url: 'http://localhost:3000' }, request: { goal: 'Home' }, credentials: { email: { env: 'TOAD_TEST_EMAIL' } } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, true);
  const runs = join(project, '.toad', 'runs');
  const state = JSON.parse(readFileSync(join(runs, readdirSync(runs)[0], 'state.json'), 'utf8'));
  assert.equal(state.state, 'failed');
  assert.ok(state.error);
  assert.equal(existsSync(join(dir, 'launch.json')), false);
});

test('web handoffs reject setup commands', async t => {
  const dir = agent(t, { status: 'ok', answer: 'Verdict: PASS', code: 0 });
  const project = mkdtempSync(join(tmpdir(), 'toad-websetup-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const client = await connect(t, dir);
  await client.callTool({ name: 'setup_project', arguments: { project_path: project } });
  const handoff = { version: 1, kind: 'web', target: { url: 'http://localhost:3000', setup: ['npm ci'] }, request: { goal: 'Home' } };
  const result = await client.callTool({ name: 'run_project_test', arguments: { project_path: project, handoff } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /cli and api handoffs/);
});
