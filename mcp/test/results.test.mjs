import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overallVerdict, resultsOf, scenarioResults, verdictOf } from '../results.mjs';

const report = `Verdict: FAIL
Results:
- PASS | Create and complete
- FAIL | Rejects a missing token
- ERROR | Logs in with SSO

## Verdict
One scenario failed.`;

test('the results block gives each scenario its result', () => {
  assert.equal(verdictOf(report), 'FAIL');
  assert.deepEqual(resultsOf(report), [
    { name: 'Create and complete', result: 'PASS' },
    { name: 'Rejects a missing token', result: 'FAIL' },
    { name: 'Logs in with SSO', result: 'ERROR' },
  ]);
});

test('the block is found after a stray preamble, and in bold or heading form', () => {
  const text = 'All scenarios are complete. Compiling the report.\n\nVerdict: PASS\n**Results:**\n- **PASS** | `One`\n* PASS | Two\n\nmore prose';
  assert.deepEqual(resultsOf(text), [{ name: 'One', result: 'PASS' }, { name: 'Two', result: 'PASS' }]);
  assert.deepEqual(resultsOf('## Results\n\n- FAIL | Only'), [{ name: 'Only', result: 'FAIL' }]);
});

test('a report without the block has no results', () => {
  assert.deepEqual(resultsOf('Verdict: PASS\n\nAll good.'), []);
  assert.deepEqual(scenarioResults([{ name: 'A' }], []), [{ name: 'A', result: 'ERROR', missing: true }]);
});

test('results follow the requested scenarios; a missing one is ERROR', () => {
  const requested = [{ name: 'Create and complete' }, { name: 'Rejects a missing token' }, { name: 'Never reported' }];
  assert.deepEqual(scenarioResults(requested, resultsOf(report)), [
    { name: 'Create and complete', result: 'PASS' },
    { name: 'Rejects a missing token', result: 'FAIL' },
    { name: 'Never reported', result: 'ERROR', missing: true },
  ]);
  // Without named scenarios, the agent's own names are kept.
  assert.equal(scenarioResults(undefined, resultsOf(report)).length, 3);
});

test('the verdict never contradicts a scenario', () => {
  const pass = { result: 'PASS' }, fail = { result: 'FAIL' }, error = { result: 'ERROR' };
  assert.equal(overallVerdict('PASS', [pass, error]), 'ERROR');
  assert.equal(overallVerdict('PASS', [error, fail]), 'FAIL');
  assert.equal(overallVerdict('ERROR', [pass, fail]), 'FAIL');
  assert.equal(overallVerdict('FAIL', [pass, pass]), 'FAIL');
  assert.equal(overallVerdict('UNKNOWN', [pass, pass]), 'PASS');
  assert.equal(overallVerdict('PASS', []), 'PASS');
});

test('duplicate result formatting cannot overwrite an observed failure', () => {
  assert.deepEqual(scenarioResults([{ name: 'A' }], [{ name: 'A', result: 'FAIL' }, { name: 'A', result: 'PASS' }]), [{ name: 'A', result: 'FAIL' }]);
  assert.deepEqual(scenarioResults([{ name: 'A' }], [{ name: 'A', result: 'PASS' }, { name: 'A', result: 'PASS' }]), [{ name: 'A', result: 'ERROR' }]);
});
