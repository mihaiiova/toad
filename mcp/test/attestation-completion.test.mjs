import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProject } from '../run.mjs';
import { scoreEvaluation } from '../evaluation-score.mjs';

// Harness-only: real runProject/record writer/reader, no model or product calls.
test('completed ERROR attestations are conclusions, not missing execution evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'toad-attestation-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent');
  mkdirSync(join(agent, '.pi/git/github.com/mihaiiova/pi-commands'), { recursive: true });
  writeFileSync(join(agent, '.pi/git/github.com/mihaiiova/pi-commands/package.json'), '{}');
  writeFileSync(join(agent, '.pi/system.yaml'), 'orchestrator:\n  model: fixture/offline\nagents:\n  - name: cli-tester\n    model: fixture/offline\n  - name: api-tester\n    model: fixture/offline\n');
  const program = join(agent, 'fake-pi.mjs');
  const executionModule = new URL('../../agent/tools/toad-execution.mjs', import.meta.url).href;
  writeFileSync(program, `#!/usr/bin/env node
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { executionContext, beginExecution, finishExecution, operationReceipt, attestScenario, readExecutionRecords } from ${JSON.stringify(executionModule)};
const mode = process.env.COMPLETION_MODE;
const conclusion = ['PASS', 'FAIL'].includes(mode) ? mode : 'ERROR';
if (mode !== 'missing') {
  const h = beginExecution(executionContext(process.env, 'Probe'), 'runCommand');
  if (mode !== 'unfinished') {
    const machine = mode.startsWith('machine-');
    const outcome = machine ? mode === 'machine-failure' ? 'FAIL' : 'ERROR' : mode === 'operation-error' ? 'ERROR' : 'completed';
    const steps = machine ? [{ index: 1, operation: 'exitCode', startedAt: h.record.startedAt, finishedAt: new Date().toISOString(), outcome, assertion: { kind: 'exitCode', result: outcome } }] : [];
    finishExecution(h, { outcome, steps, artifacts: [operationReceipt(h, outcome)], evidenceComplete: true, ...(machine ? { verification: { source: 'machine', executionIds: [] } } : {}) });
    if (!machine) attestScenario(process.env, { scenarioName: 'Probe', result: conclusion, executionIds: [h.record.id] });
    if (mode === 'receipt-loss') {
      const record = readExecutionRecords(h.run).records.find(r => r.id === h.record.id);
      unlinkSync(join(h.run, record.artifacts[0].path));
    }
  }
}
const reported = ['optimistic', 'machine-failure'].includes(mode) ? 'PASS' : conclusion;
const answer = 'Verdict: ' + reported + (process.env.COMPLETION_GOAL_ONLY ? '' : '\\nResults:\\n- ' + reported + ' | Probe');
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer }] }] }));
`, { mode: 0o755 });

  for (const kind of ['cli', 'api']) for (const mode of ['PASS', 'ERROR', 'FAIL', 'missing', 'receipt-loss', 'operation-error', 'unfinished', 'machine-error', 'machine-failure', 'optimistic', 'goal-only', 'goal-only-fail', 'goal-only-machine-failure']) {
    await t.test(`${kind}: ${mode}`, async () => {
      const project = join(root, `${kind}-${mode}`);
      mkdirSync(join(project, '.toad/runs'), { recursive: true });
      writeFileSync(join(project, '.toad/.gitignore'), '.env\nruns/\n');
      writeFileSync(join(project, '.toad/toad.yaml'), '{}\n');
      const goalOnly = mode.startsWith('goal-only');
      const result = await runProject({ project_path: project, handoff: {
        version: 1, kind, target: kind === 'cli' ? { workdir: project, program: 'example' } : { workdir: project, url: 'https://fixture.invalid' },
        request: { goal: 'Probe', ...(!goalOnly ? { scenarios: [{ name: 'Probe', steps: 'Inspect the fixture', expected: 'Report observed uncertainty' }] } : {}) },
      } }, { signal: new AbortController().signal }, { env: {
        ...process.env, TOAD_AGENT_DIR: agent, TOAD_PI: program, TOAD_CONFIG_DIR: join(root, 'config'),
        TOAD_CACHE_DIR: join(root, 'cache'), TOAD_RUNTIME_DIR: join(root, 'runtime'),
        COMPLETION_MODE: mode === 'goal-only-fail' ? 'FAIL' : mode === 'goal-only-machine-failure' ? 'machine-failure' : goalOnly ? 'ERROR' : mode, COMPLETION_GOAL_ONLY: goalOnly ? '1' : '',
      } });
      const { status, verdict, scenarios } = result.structuredContent;
      const complete = ['PASS', 'ERROR', 'FAIL', 'machine-failure'].includes(mode) || goalOnly;
      assert.equal(status, complete ? 'ok' : 'evidence_error');
      const expected = ['FAIL', 'machine-failure', 'goal-only-fail', 'goal-only-machine-failure'].includes(mode) ? 'FAIL' : mode === 'PASS' ? 'PASS' : 'ERROR';
      assert.equal(verdict, expected);
      assert.equal(scenarios.length, 1);
      assert.equal(scenarios[0].result, expected);
      if (mode === 'ERROR' || mode === 'goal-only') {
        const score = scoreEvaluation([{ id: 'probe', expectedClass: 'ERROR' }], [{
          id: 'probe', executed: true, classification: verdict, complete: status === 'ok', evidenceComplete: true, infrastructureFailure: status !== 'ok',
        }]);
        assert.equal(score.complete, true);
        assert.equal(score.accuracy.count, 1, 'fully evidenced expected ERROR earns credit, never PASS');
      }
    });
  }
});
