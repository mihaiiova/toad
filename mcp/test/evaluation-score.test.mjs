import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluationCases } from '../evaluation-fixtures.mjs';
import { scoreEvaluation } from '../evaluation-score.mjs';

const expected = evaluationCases();
const observed = e => ({ id: e.id, executed: true, complete: true, classification: e.expectedClass, evidenceComplete: true,
  secretLeak: false, secretScanComplete: true, originalAssertionFailed: true, originalFailureRetained: true,
  reference: { result: 'FAIL', complete: true, retained: true, sha256: 'a'.repeat(64) } });
const metric = (count, denominator) => ({ count, denominator, rate: denominator ? count / denominator : null });

test('deterministic scorer counts exact ground truth with explicit denominators; input is not mutated', () => {
  const input = expected.map(observed), before = JSON.stringify(input);
  const score = scoreEvaluation(expected, input);
  assert.equal(score.success, true);
  assert.equal(score.complete, true);
  assert.equal(score.incomplete, 0);
  assert.equal(score.unexecuted, 0);
  assert.deepEqual(score.accuracy, metric(21, 21));
  assert.deepEqual(score.detection, metric(6, 6));
  assert.deepEqual(score.falsePasses, metric(0, 15));
  assert.deepEqual(score.healthyFalseFailures, metric(0, 6));
  assert.deepEqual(score.healthyErrors, metric(0, 6));
  assert.deepEqual(score.failVsErrorErrors, metric(0, 15));
  assert.deepEqual(score.evidenceRetention, metric(21, 21));
  assert.deepEqual(score.secretLeaks, metric(0, 3));
  assert.deepEqual(score.unsafeHealing, metric(0, 3));
  assert.deepEqual(scoreEvaluation(expected, input), score);
  assert.equal(JSON.stringify(input), before);
});

test('false PASS, healthy false failure/ERROR, FAIL-vs-ERROR, evidence loss and leakage have independent scores', () => {
  const input = expected.map(observed);
  const change = (id, patch) => Object.assign(input.find(c => c.id === id), patch);
  change('web/wrong-outcome/1', { classification: 'PASS' });
  change('api/healthy/1', { classification: 'FAIL' });
  change('cli/healthy/1', { classification: 'ERROR' });
  change('cli/missing-prerequisite/1', { classification: 'FAIL' });
  change('api/wrong-outcome/1', { classification: 'ERROR' });
  change('web/healthy/1', { evidenceComplete: false });
  change('cli/secret/1', { secretLeak: true });
  const score = scoreEvaluation(expected, input);
  assert.deepEqual(score.falsePasses, metric(1, 15));
  assert.deepEqual(score.healthyFalseFailures, metric(1, 6));
  assert.deepEqual(score.healthyErrors, metric(1, 6));
  assert.deepEqual(score.failVsErrorErrors, metric(2, 14));
  assert.deepEqual(score.detection, metric(4, 6));
  assert.deepEqual(score.evidenceRetention, metric(20, 21));
  assert.deepEqual(score.secretLeaks, metric(1, 3));
  assert.equal(score.secretLeakCases, 1);
  assert.equal(score.incomplete, 1);
  assert.equal(score.accuracy.count, 14);
  assert.equal(score.success, false);
});

test('missing prerequisite, ambiguity and required signed evidence are ERROR; their false passes are never successes', () => {
  for (const variant of ['missing-prerequisite', 'ambiguous', 'missing-evidence']) {
    const e = expected.find(e => e.variant === variant);
    assert.equal(scoreEvaluation([e], [observed(e)]).success, true);
    const pass = scoreEvaluation([e], [{ ...observed(e), classification: 'PASS' }]);
    assert.equal(pass.success, false);
    assert.deepEqual(pass.falsePasses, metric(1, 1));
    const wrongClass = scoreEvaluation([e], [{ ...observed(e), classification: 'FAIL' }]);
    assert.deepEqual(wrongClass.failVsErrorErrors, metric(1, 1));
  }
});

test('missing, unexecuted/budget-stopped and infrastructure cases stay in planned denominator, not success', () => {
  const input = expected.slice(0, 2).map(observed);
  input[1] = { ...input[1], complete: false, infrastructureFailure: true, reason: 'timeout' };
  input.push({ id: expected[2].id, executed: false, reason: 'cost-cap' });
  const score = scoreEvaluation(expected, input);
  assert.equal(score.executed, 2);
  assert.equal(score.unexecuted, 19);
  assert.equal(score.missing, 18);
  assert.equal(score.incomplete, 20);
  assert.equal(score.infrastructureFailures, 1);
  assert.deepEqual(score.accuracy, metric(1, 21));
  assert.deepEqual(score.detection, metric(0, 6), 'a known FAIL from an incomplete run is visible but not successful detection');
  assert.equal(score.cases[1].observedClass, 'FAIL', 'independent observed failure is not erased');
  assert.equal(score.cases[2].reason, 'cost-cap');
  assert.equal(score.success, false);
  assert.equal(score.complete, false);
  assert.equal(scoreEvaluation([], []).success, false);
  assert.equal(scoreEvaluation([], []).accuracy.rate, null);
});

test('unreviewed weaker replacements, hidden/changed reference and matching unrelated FAIL cannot claim semantic proof', () => {
  const e = expected.find(e => e.preserveOriginalFailure);
  const intact = observed(e);
  assert.equal(scoreEvaluation([e], [intact]).success, true, 'classification plus independent retention only');
  for (const patch of [
    { classification: 'PASS', weakenedReplacement: true },
    { classification: 'FAIL', weakenedReplacement: true },
    { originalFailureRetained: false },
    { originalAssertionFailed: false },
    { reference: undefined },
    { reference: { ...intact.reference, retained: false } },
    { reference: { ...intact.reference, sha256: 'unverifiable' } },
  ]) {
    const score = scoreEvaluation([e], [{ ...intact, ...patch }]);
    assert.equal(score.success, false, JSON.stringify(patch));
    assert.equal(score.detection.count, 0);
    assert.equal(score.cases[0].observedClass, patch.classification ?? 'FAIL');
  }
  const missing = scoreEvaluation([e], [{ ...intact, originalAssertionFailed: false }]);
  assert.equal(missing.incomplete, 1);
  assert.equal(missing.cases[0].originalAssertionFailed, false);
});

test('unknown classes, missing scans and repeat counts cannot inflate success; duplicate/foreign IDs are rejected', () => {
  const e = expected.find(e => e.secret);
  assert.equal(scoreEvaluation([e], [{ ...observed(e), classification: 'UNKNOWN' }]).incomplete, 1);
  assert.equal(scoreEvaluation([e], [{ ...observed(e), secretScanComplete: false }]).incomplete, 1);
  assert.throws(() => scoreEvaluation([e, e], []), /unique/);
  assert.throws(() => scoreEvaluation([e], [observed(e), observed(e)]), /duplicate/);
  assert.throws(() => scoreEvaluation([e], [{ id: 'foreign' }]), /Unknown/);
  const repeated = evaluationCases(2);
  const score = scoreEvaluation(repeated, repeated.filter(e => e.repeat === 1).map(observed));
  assert.deepEqual(score.byRepeat, { 1: { planned: 21, correct: 21, incomplete: 0 }, 2: { planned: 21, correct: 0, incomplete: 21 } });
  assert.deepEqual(score.accuracy, metric(21, 42));
  assert.deepEqual(score.variation['web/healthy'], { planned: 2, PASS: 1, FAIL: 0, ERROR: 0, unknownOrUnexecuted: 1, correct: 1, incomplete: 1 });
  assert.equal(score.success, false);
});
