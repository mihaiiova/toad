import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'revisor-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(behaviour));
  writeFileSync(join(dir, 'run'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync('args.json', JSON.stringify(args));
fs.writeFileSync('pid', String(process.pid));
const b = JSON.parse(fs.readFileSync('behaviour.json', 'utf8'));
const receipts = args.find(a => a.startsWith('receipts=')).slice('receipts='.length);
fs.mkdirSync(receipts, { recursive: true });
fs.writeFileSync(path.join(receipts, 'scenario-01-home.png'), Buffer.from(${JSON.stringify(PNG)}, 'base64'));
const finish = () => { console.log('pi output'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: b.status, answer: b.answer, toolErrors: 0 })); process.exit(b.code); };
process.on('SIGTERM', () => { fs.writeFileSync('cancelled', 'yes'); console.log(JSON.stringify({ workflow: 'test', runId: 'run-1', status: 'cancelled', answer: '', toolErrors: 0 })); process.exit(1); });
setTimeout(finish, b.delay ?? 0);
`, { mode: 0o755 });
  return dir;
}

async function connect(t, dir) {
  const client = new Client({ name: 'revisor-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, REVISOR_AGENT_DIR: dir } }));
  t.after(() => client.close());
  return client;
}

const report = verdict => `# Test report\n\n## Verdict\n\n${verdict}\n\nThe home page loads.\n\n## Scenarios\n\n**home — ${verdict}**`;

test('run_web_test runs the workflow and returns the verdict, report and screenshots', async t => {
  const dir = agent(t, { status: 'ok', answer: report('FAIL'), code: 0 });
  const client = await connect(t, dir);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['run_web_test']);
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
  assert.match(args.find(a => a.startsWith('receipts=')), /^receipts=data\/receipts\/[0-9a-f-]{36}$/, 'a folder per call, so parallel calls never mix receipts');
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
  for (const [answer, verdict] of [['# Verdict\n\nERROR\n\nThe site was down.', 'ERROR'], ['### Verdict\n**PASS**', 'PASS'], ['All good.', 'UNKNOWN']]) {
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
