/** Synthetic cross-backend tool receipts for fake-Pi orchestration fixtures, never real tester validation. */
import { beginExecution, executionContext, finishExecution, operationReceipt } from '../../agent/tools/toad-execution.mjs';

export function fakeExecutionEvidence(env, answer, { skip = false, machineFailure = false } = {}) {
  if (!env.TOAD_EXECUTION_RUN_DIR || skip) return;
  const declared = JSON.parse(env.TOAD_EXECUTION_SCENARIOS ?? '[]');
  const reported = [...String(answer).matchAll(/^[-*] (?:PASS|FAIL|ERROR) \| (.+)$/gm)].map(m => m[1]);
  for (const name of declared.length ? declared : reported.length ? reported : ['Fixture-derived scenario']) {
    const context = executionContext(env, name);
    const handle = beginExecution(context, 'fixture_operation');
    const outcome = machineFailure ? 'FAIL' : context.kind === 'web' ? 'completed' : 'PASS';
    const receipt = operationReceipt(handle, outcome);
    finishExecution(handle, { outcome, ...(context.kind !== 'web' ? { verification: { source: 'machine', executionIds: [] }, steps: [{ index: 1, operation: 'exitCode', startedAt: handle.record.startedAt, finishedAt: new Date().toISOString(), outcome: machineFailure ? 'FAIL' : 'PASS', assertion: { kind: 'exitCode', result: machineFailure ? 'FAIL' : 'PASS' } }] } : {}), artifacts: [receipt], evidenceComplete: true });
  }
}
