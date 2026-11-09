import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { evaluationCases, FIXTURE_VERSION, SENTINEL } from '../evaluation-fixtures.mjs';
import { evaluationReferenceState, observeEvaluationCase, parseEvaluationArgs, requireEvaluationSandbox, runEvaluation, scanEvaluationArtifacts } from '../evaluation.mjs';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
const DRIVER = resolve(import.meta.dirname, 'fake-web-driver.mjs');
const COMMANDS = '.pi/git/github.com/mihaiiova/pi-commands/package.json';
function temp(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'toad-evaluation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function options(root, extra = {}) {
  return { real: true, output: join(root, 'evaluation'), models: { lead: 'fixture/offline', tester: 'fixture/offline' }, maxCost: 1, maxSeconds: 120, maxScenarios: 21, sandbox: 'none', ...extra };
}
function synthetic({ definition }) {
  return { id: definition.id, executed: true, complete: true, classification: definition.expectedClass, evidenceComplete: true, secretLeak: false, secretScanComplete: true, cost: 0.001, status: 'ok', originalAssertionFailed: true, originalFailureRetained: true,
    reference: { result: 'FAIL', complete: true, retained: true, sha256: 'a'.repeat(64) } };
}

test('explicit opt-in, models and positive cost/time/scenario caps are checked before any work', async t => {
  const root = temp(t), base = options(root);
  let invoked = 0;
  for (const patch of [
    { real: false }, { maxCost: undefined }, { maxCost: 0 }, { maxCost: NaN }, { maxSeconds: undefined }, { maxSeconds: Infinity }, { maxSeconds: 0 },
    { maxScenarios: undefined }, { maxScenarios: 0 }, { maxScenarios: 1.5 }, { maxScenarios: 211 }, { models: { lead: 'fixture/offline' } },
    { models: { lead: 'plain', tester: 'fixture/offline' } }, { repeats: 11 }, { sandbox: 'invalid' }, { sandbox: 'container' },
  ]) {
    await assert.rejects(runEvaluation({ ...base, ...patch }, { preflight() { invoked++; }, runCase() { invoked++; } }));
    assert.equal(existsSync(base.output), false);
  }
  assert.equal(invoked, 0);
  assert.throws(() => requireEvaluationSandbox({ sandbox: 'container' }), /no automatic downgrade/);
  assert.equal(requireEvaluationSandbox({ sandbox: 'bwrap' }), 'bwrap');
  assert.equal(requireEvaluationSandbox({ sandbox: 'none' }), 'none');
  const argv = ['--real', '--output', base.output, '--lead-model', 'fixture/offline', '--tester-model=fixture/offline', '--max-cost=.1', '--max-seconds', '10', '--max-scenarios=3', '--sandbox=none'];
  assert.equal(parseEvaluationArgs(argv).maxScenarios, 3);
  for (const bad of [[], ['--real'], [...argv, '--max-cost=2'], [...argv, '--unknown'], [...argv, '--real=yes']]) assert.throws(() => parseEvaluationArgs(bad));
});

test('product-facing command gives safe help and refuses unbudgeted execution without keys or downloads', t => {
  const root = temp(t);
  const env = { PATH: process.env.PATH, HOME: root, TOAD_CONFIG_DIR: join(root, 'config') };
  const help = spawnSync(process.execPath, [CLI, 'evaluate', '--help'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--max-cost/);
  assert.match(help.stdout, /harness-only/);
  const no = spawnSync(process.execPath, [CLI, 'evaluate', '--real', '--output', join(root, 'out')], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /Explicit lead model/);
  assert.equal(existsSync(join(root, 'out')), false);
});

test('harness injection is visibly not agent quality, has reproducible identities and never records environment secrets', async t => {
  const root = temp(t), opts = options(root);
  const originalConfig = process.env.TOAD_CONFIG_DIR;
  const calls = [];
  const { manifest, exitCode } = await runEvaluation(opts, { runCase: args => {
    calls.push({ id: args.definition.id, project: args.project, workdir: args.fixture.workdir, url: args.fixture.url });
    assert.notEqual(args.env.TOAD_CONFIG_DIR, originalConfig);
    assert.ok(args.project.startsWith(join(opts.output, 'projects')));
    return synthetic(args);
  } });
  assert.equal(exitCode, 0, 'a harness contract result, not a real tester quality baseline');
  assert.equal(manifest.mode, 'harness-only');
  assert.equal(manifest.agentQualityEvidence, false);
  assert.match(manifest.warning, /not evidence/);
  assert.equal(manifest.score.accuracy.count, 21);
  assert.equal(manifest.score.unexecuted, 0);
  assert.equal(new Set(calls.map(c => c.workdir)).size, 21);
  assert.equal(new Set(calls.map(c => c.project)).size, 21);
  assert.equal(existsSync(join(opts.output, 'work')), false);
  assert.equal(manifest.sourceCleanupComplete, true);
  for (const url of calls.map(c => c.url).filter(Boolean)) await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  assert.equal(manifest.fixtureVersion, FIXTURE_VERSION);
  assert.equal(manifest.fixtureVersion, '2', 'corrected selected web credential has new fixture provenance');
  assert.match(manifest.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.harnessSha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.toadVersion);
  assert.deepEqual(manifest.models, opts.models);
  assert.equal(manifest.budgets.maxCost, opts.maxCost);
  assert.equal(manifest.sandbox, 'none');
  assert.match(manifest.isolation, /NONE/);
  assert.ok(manifest.recordedCost > 0);
  assert.equal(process.env.TOAD_CONFIG_DIR, originalConfig);
  const saved = readFileSync(join(opts.output, 'manifest.json'), 'utf8');
  assert.equal(saved.includes(SENTINEL), false);
  assert.deepEqual(JSON.parse(saved), manifest);
  const second = await runEvaluation(options(root, { output: join(root, 'second') }), { runCase: synthetic });
  assert.equal(second.manifest.fixtureSha256, manifest.fixtureSha256);
  assert.equal(second.manifest.harnessSha256, manifest.harnessSha256);
  assert.deepEqual(second.manifest.expected, manifest.expected);
  await assert.rejects(runEvaluation(opts, { runCase: synthetic }), /EEXIST/);
});

test('complete quality/safety mismatches are measured failures, not infrastructure success or invented accuracy', async t => {
  const root = temp(t);
  const { manifest, exitCode } = await runEvaluation(options(root), { runCase: args => ({
    ...synthetic(args),
    ...(['web/wrong-outcome/1', 'web/unsafe-healing/1'].includes(args.definition.id) ? { classification: 'PASS', weakenedReplacement: args.definition.preserveOriginalFailure } : {}),
    ...(args.definition.id === 'cli/secret/1' ? { secretLeak: true, leakedFiles: 1 } : {}),
  }) });
  assert.equal(exitCode, 1);
  assert.equal(manifest.score.complete, true);
  assert.equal(manifest.score.success, false);
  assert.equal(manifest.score.falsePasses.count, 2);
  assert.equal(manifest.score.unsafeHealing.count, 1);
  assert.equal(manifest.score.secretLeakCases, 1);
  assert.equal(manifest.score.unexecuted, 0);
});

test('real mode refuses fake backend overrides before output allocation or backend/model work', async t => {
  const root = temp(t), saved = process.env.TOAD_PI;
  try {
    process.env.TOAD_PI = '/not-a-real-tester';
    await assert.rejects(runEvaluation(options(root)), /refuses fake/);
    assert.equal(existsSync(join(root, 'evaluation')), false);
  } finally { if (saved === undefined) delete process.env.TOAD_PI; else process.env.TOAD_PI = saved; }
});

test('scenario, time, cost and unknown-cost stops record every omitted case rather than passing them', async t => {
  const root = temp(t);
  for (const mode of ['scenario', 'time', 'cost', 'unknown', 'cost-status']) {
    let clock = 100000, calls = 0;
    const opts = options(root, { output: join(root, mode), maxSeconds: 10, maxScenarios: mode === 'scenario' ? 1 : 21, maxCost: mode === 'cost' ? 0.001 : 1 });
    const { manifest, exitCode } = await runEvaluation(opts, { now: () => clock, runCase: args => {
      calls++;
      if (mode === 'time') clock += 11000;
      return { ...synthetic(args), ...(mode === 'unknown' ? { cost: null } : {}), ...(mode === 'cost-status' ? { status: 'cost_limit' } : {}) };
    } });
    assert.equal(calls, 1, mode);
    assert.equal(exitCode, 2);
    assert.equal(manifest.score.unexecuted, 20);
    assert.equal(manifest.score.success, false);
    assert.equal(manifest.score.accuracy.denominator, 21);
    assert.equal(manifest.score.incomplete, ['scenario', 'cost'].includes(mode) ? 20 : 21);
    assert.equal(manifest.observations.length, 21);
    if (mode === 'unknown') { assert.equal(manifest.unknownCostCases, 1); assert.equal(manifest.stopReason, 'unknown-cost'); }
  }
});

test('cancellation and fixture/runner exceptions close services, restore directories and publish incomplete safe manifests', async t => {
  const root = temp(t), stop = new AbortController();
  stop.abort();
  let calls = 0;
  const cancelled = await runEvaluation(options(root), { signal: stop.signal, runCase() { calls++; } });
  assert.equal(calls, 0);
  assert.equal(cancelled.exitCode, 2);
  assert.equal(cancelled.manifest.score.unexecuted, 21);
  const before = process.env.TOAD_CONFIG_DIR;
  let url;
  const failed = await runEvaluation(options(root, { output: join(root, 'failed') }), { runCase: args => { url = args.fixture.url; throw new Error(`provider error SECRET ${SENTINEL}`); } });
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.manifest.score.infrastructureFailures, 1);
  assert.equal(failed.manifest.score.unexecuted, 20);
  assert.equal(JSON.stringify(failed.manifest).includes(SENTINEL), false);
  assert.equal(process.env.TOAD_CONFIG_DIR, before);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});

test('sentinel scanner detects retained raw/base64 output, rejects symlinks and marks oversized output incomplete', t => {
  const root = temp(t), output = join(root, 'run');
  mkdirSync(output);
  writeFileSync(join(output, 'report.md'), 'redacted');
  assert.deepEqual(scanEvaluationArtifacts(output), { complete: true, leaked: false, leakedFiles: 0 });
  writeFileSync(join(output, 'session.jsonl'), SENTINEL);
  writeFileSync(join(output, 'receipt.txt'), Buffer.from(SENTINEL).toString('base64'));
  assert.equal(scanEvaluationArtifacts(output).leakedFiles, 2);
  symlinkSync(join(output, 'report.md'), join(output, 'link'));
  assert.equal(scanEvaluationArtifacts(output).complete, false);
  unlinkSync(join(output, 'link'));
  writeFileSync(join(output, 'oversized'), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(scanEvaluationArtifacts(output).complete, false);
});

// Fake Pi tests ONLY orchestration and typed receipt wiring. It is explicitly not an actual tester.
function fakeAgent(root) {
  const agent = join(root, 'agent');
  mkdirSync(join(agent, dirname(COMMANDS)), { recursive: true });
  writeFileSync(join(agent, COMMANDS), '{}');
  writeFileSync(join(agent, '.pi', 'system.yaml'), 'orchestrator:\n  name: lead\n  model: fixture/offline\nagents:\n  - name: tester\n    model: fixture/offline\n');
  const program = join(agent, 'fake-pi.mjs');
  writeFileSync(program, `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import { fakeExecutionEvidence } from ${JSON.stringify(new URL('./fake-web-evidence.mjs', import.meta.url).href)};
const args = process.argv.slice(2), sessions = args[args.indexOf('--session-dir') + 1];
const names = JSON.parse(process.env.TOAD_EXECUTION_SCENARIOS);
const classes = ${JSON.stringify(Object.fromEntries(evaluationCases().map(e => [e.id, e.expectedClass])))};
fs.writeFileSync(path.join(sessions,'lead.jsonl'), JSON.stringify({type:'message',message:{role:'assistant',provider:'fixture',model:'offline',usage:{cost:{total:0.001}}}})+'\\n');
const lines = names.map(name => '- ' + classes[name] + ' | ' + name);
fakeExecutionEvidence(process.env, lines.join('\\n'));
const verdict = names.some(n=>classes[n]==='FAIL')?'FAIL':names.some(n=>classes[n]==='ERROR')?'ERROR':'PASS';
console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:['Verdict: '+verdict,'Results:',...lines].join('\\n')}]}]}));
`, { mode: 0o755 });
  return { agent, program };
}

test('existing runProject/fake-Pi seam, real CLI/API reference replay and fake browser reference form bounded offline harness evidence', async t => {
  const root = temp(t), fake = fakeAgent(root), app = join(root, 'app.json');
  writeFileSync(app, JSON.stringify({ pages: {
    '/': { elements: [{ role: 'button', name: 'Calculate invoice', goto: '/invoice' }] },
    '/invoice': { elements: [{ role: 'status', name: 'Invoice total', text: 'Total: $5' }] },
  } }));
  const { manifest, exitCode } = await runEvaluation(options(root), { runCase: args => observeEvaluationCase({ ...args, env: {
    ...args.env, TOAD_AGENT_DIR: fake.agent, TOAD_PI: fake.program, TOAD_WEB_DRIVER: JSON.stringify([process.execPath, DRIVER]), FAKE_WEB_APP: app, FAKE_WEB_LOG: join(root, 'calls.log'), TOAD_WEB_STEP_TIMEOUT_MS: '500',
  } }) });
  assert.equal(exitCode, 0, 'harness-only; fake Pi cannot establish real agent quality');
  assert.equal(manifest.mode, 'harness-only');
  assert.equal(manifest.agentQualityEvidence, false);
  assert.equal(manifest.score.executed, 21);
  assert.equal(manifest.score.incomplete, 0);
  assert.equal(manifest.unknownCostCases, 0);
  assert.ok(manifest.observations.every(o => o.observedModels.includes('fixture/offline')));
  for (const e of manifest.expected.filter(e => e.preserveOriginalFailure)) {
    const o = manifest.observations.find(o => o.id === e.id);
    assert.equal(o.originalAssertionFailed, true);
    assert.equal(o.originalFailureRetained, true);
    assert.equal(o.classification, 'FAIL');
    assert.equal(o.reference.result, 'FAIL');
    assert.equal(o.reference.retained, true);
    const referenceRun = join(root, 'evaluation', o.reference.run);
    assert.ok(existsSync(join(referenceRun, 'reports', 'report.md')));
    const before = await evaluationReferenceState(referenceRun);
    assert.equal(before.sha256, o.reference.sha256);
    // Destructive test edit only: a missing original proof is distinguishable from a matching tester FAIL.
    const { readExecutionRecords } = await import('../../agent/tools/toad-execution.mjs');
    const original = readExecutionRecords(referenceRun).records[0];
    const proof = original.artifacts.find(a => a.kind === 'receipt');
    unlinkSync(join(referenceRun, proof.path));
    assert.equal((await evaluationReferenceState(referenceRun)).complete, false);
  }
  assert.match(manifest.limitations.join(' '), /unrelated FAIL/);
});
