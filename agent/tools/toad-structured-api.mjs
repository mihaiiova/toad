#!/usr/bin/env node
/** Credential-free structured HTTP request, executed through the scenario runner. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiCliPayload, validApiPayload } from './toad-api-recording.mjs';
import { candidateFits } from './toad-cli-recording.mjs';
let result;
try {
  const raw = readFileSync(process.argv[2] ?? 0);
  if (raw.length > 16384 || process.argv.length > 3) throw Error();
  const q = JSON.parse(raw);
  const fields = ['name','payload','receipts','scenario', ...(q.capture ? ['capture'] : []), ...(Object.hasOwn(q, 'scenarioName') ? ['scenarioName'] : [])];
  if (!q || Object.keys(q).sort().join(',') !== fields.sort().join(',') || !validApiPayload(q.payload) || (q.capture && (Object.keys(q.capture).sort().join(',') !== 'complete,scenarioName' || q.capture.complete !== true || typeof q.capture.scenarioName !== 'string' || !q.capture.scenarioName.trim()))) throw Error();
  const payload = apiCliPayload(q.payload);
  const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'toad-structured-cli.mjs')], { input: JSON.stringify({ scenario: q.scenario, receipts: q.receipts, name: q.name, ...payload, ...(q.scenarioName ?? q.capture?.scenarioName ? { scenarioName: q.scenarioName ?? q.capture.scenarioName } : {}) }), encoding: 'utf8', maxBuffer: 8*1024*1024, env: { ...process.env, TOAD_EXECUTION_KIND: 'api', TOAD_EXECUTION_EXPECT: JSON.stringify(q.payload.expect) } });
  if (run.error || run.signal) throw Error();
  result = JSON.parse(run.stdout);
  if (result.actual?.exitCode === 2 || result.actual?.exitCode === 127) result = { status: 'error', error: 'HTTP execution or prerequisite error', receipt: result.receipt };
  if (q.capture) {
    result.captured = false;
    if (result.status === 'pass' && process.env.TOAD_RECORDING_ENABLED === 'api-v1' && candidateFits(payload, q.capture.scenarioName)) {
      const candidate = JSON.stringify({ version: 1, scenarioName: q.capture.scenarioName, payload: q.payload })+'\n';
      if (Buffer.byteLength(candidate) <= 16384) {
        try { writeFileSync(`${result.receipt}.recording.json`, candidate, { flag: 'wx', mode: 0o600 }); result.captured = true; } catch {}
      }
    }
  }
} catch { result = { status: 'error', error: 'Invalid API request or execution failure' }; }
process.stdout.write(JSON.stringify(result)+'\n');
process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
