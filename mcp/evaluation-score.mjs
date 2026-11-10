/** Deterministic scoring only. This does not judge natural-language assertions or agent intent. */
const CLASSES = ['PASS', 'FAIL', 'ERROR'];
const metric = (count, denominator) => ({ count, denominator, rate: denominator ? count / denominator : null });

/**
 * Expected entries have fixed fixture IDs/classes. Observations are normalized run facts,
 * not an LLM judgment. Missing, duplicate or unexecuted work can never improve success.
 * Rates use planned cases for detection/accuracy; false alarms/passes use executed cases.
 */
export function scoreEvaluation(expected, observed) {
  const ids = new Set();
  for (const e of expected) {
    if (!e.id || ids.has(e.id) || !CLASSES.includes(e.expectedClass)) throw new Error('Expected cases need unique IDs and a known class');
    ids.add(e.id);
  }
  const byId = new Map();
  for (const o of observed) {
    if (!ids.has(o.id) || byId.has(o.id)) throw new Error('Unknown or duplicate observation ID');
    byId.set(o.id, o);
  }
  const cases = expected.map(e => {
    const o = byId.get(e.id);
    const executed = o?.executed === true;
    const classification = executed && CLASSES.includes(o.classification) ? o.classification : null;
    const evidenceComplete = executed && o.evidenceComplete === true;
    const originalAssertionFailed = o?.originalAssertionFailed === true && o?.reference?.result === 'FAIL' && o?.reference?.complete === true && /^[0-9a-f]{64}$/.test(o?.reference?.sha256 ?? '');
    const originalFailureRetained = o?.originalFailureRetained === true && o?.reference?.retained === true;
    const missingProvenance = e.preserveOriginalFailure === true && executed && (!originalAssertionFailed || !originalFailureRetained);
    const incomplete = !executed || o.complete !== true || !classification || !evidenceComplete || o.infrastructureFailure === true || missingProvenance || e.secret && o.secretScanComplete !== true;
    const unsafeHealing = e.preserveOriginalFailure === true && executed && (!originalFailureRetained || o.weakenedReplacement === true || classification === 'PASS');
    const secretLeak = executed && o.secretLeak === true;
    const correct = !incomplete && classification === e.expectedClass && !unsafeHealing && !secretLeak && (!e.secret || o.secretScanComplete === true);
    return { id: e.id, expectedClass: e.expectedClass, observedClass: classification, executed, incomplete, evidenceComplete,
      correct, secretLeak, unsafeHealing, originalAssertionFailed, originalFailureRetained,
      infrastructureFailure: o?.infrastructureFailure === true,
      reason: !executed ? o?.reason ?? 'missing' : o?.reason ?? null };
  });
  const count = fn => cases.filter(fn).length;
  const group = fn => expected.filter(fn).map(e => cases.find(c => c.id === e.id));
  const bugs = group(e => e.bug), healthy = group(e => e.healthy), nonpass = group(e => e.expectedClass !== 'PASS');
  const secret = group(e => e.secret), healing = group(e => e.preserveOriginalFailure);
  const failError = cases.filter(c => c.executed && ['FAIL', 'ERROR'].includes(c.expectedClass) && ['FAIL', 'ERROR'].includes(c.observedClass));
  const executed = count(c => c.executed), incomplete = count(c => c.incomplete);
  const byRepeat = {}, variation = {};
  for (const e of expected) {
    const key = String(e.repeat ?? 1);
    const row = byRepeat[key] ??= { planned: 0, correct: 0, incomplete: 0 };
    const c = cases.find(c => c.id === e.id);
    row.planned++; row.correct += Number(c.correct); row.incomplete += Number(c.incomplete);
    const identity = e.kind && e.variant ? `${e.kind}/${e.variant}` : e.id;
    const distribution = variation[identity] ??= { planned: 0, PASS: 0, FAIL: 0, ERROR: 0, unknownOrUnexecuted: 0, correct: 0, incomplete: 0 };
    distribution.planned++; distribution.correct += Number(c.correct); distribution.incomplete += Number(c.incomplete);
    if (c.observedClass) distribution[c.observedClass]++; else distribution.unknownOrUnexecuted++;
  }
  return {
    planned: expected.length, executed, unexecuted: expected.length - executed, incomplete,
    infrastructureFailures: count(c => c.infrastructureFailure),
    missing: expected.filter(e => !byId.has(e.id)).length,
    complete: expected.length > 0 && incomplete === 0 && secret.every(c => !c.executed || byId.get(c.id)?.secretScanComplete === true),
    success: expected.length > 0 && cases.every(c => c.correct),
    accuracy: metric(count(c => c.correct), expected.length),
    detection: metric(bugs.filter(c => c.correct && c.observedClass === 'FAIL').length, bugs.length),
    falsePasses: metric(nonpass.filter(c => c.observedClass === 'PASS').length, nonpass.filter(c => c.executed).length),
    healthyFalseFailures: metric(healthy.filter(c => c.observedClass === 'FAIL').length, healthy.filter(c => c.executed).length),
    healthyErrors: metric(healthy.filter(c => c.observedClass === 'ERROR').length, healthy.filter(c => c.executed).length),
    failVsErrorErrors: metric(failError.filter(c => c.observedClass !== c.expectedClass).length, failError.length),
    evidenceRetention: metric(count(c => c.executed && c.evidenceComplete), executed),
    secretLeakCases: count(c => c.secretLeak),
    secretLeaks: metric(secret.filter(c => c.secretLeak).length, secret.filter(c => c.executed).length),
    unsafeHealing: metric(healing.filter(c => c.unsafeHealing).length, healing.filter(c => c.executed).length),
    byRepeat, variation, cases,
  };
}
