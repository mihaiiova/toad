import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationFixture, evaluationCases, INTENT, SENTINEL, VARIANTS, originalEvaluationAssertion } from '../evaluation-fixtures.mjs';
import { validApiPayload } from '../../agent/tools/toad-api-recording.mjs';
import { validCliPayload } from '../../agent/tools/toad-cli-recording.mjs';
import { validWebPayload } from '../../agent/tools/toad-web-recording.mjs';

function temp(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'toad-evaluation-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('evaluation ground truth fixes intent, classifications and identities across variants/repeats', () => {
  const cases = evaluationCases(2);
  assert.equal(cases.length, 42);
  assert.equal(new Set(cases.map(c => c.id)).size, 42);
  assert.ok(cases.every(c => c.intent === INTENT));
  for (const kind of ['web', 'api', 'cli']) {
    assert.deepEqual(cases.filter(c => c.kind === kind && c.repeat === 1).map(c => c.expectedClass), ['PASS', 'FAIL', 'ERROR', 'ERROR', 'ERROR', 'PASS', 'FAIL']);
  }
  assert.throws(() => evaluationCases(0));
  assert.throws(() => evaluationCases(11));
  assert.equal(validCliPayload(originalEvaluationAssertion('cli').payload), true);
  assert.equal(validApiPayload(originalEvaluationAssertion('api', 'http://127.0.0.1:1234').payload), true);
  assert.equal(validWebPayload(originalEvaluationAssertion('web', 'http://127.0.0.1:1234').payload), true);
});

for (const variant of VARIANTS) {
  test(`CLI fixture independently exhibits ${variant} using real Node, not fake Pi`, async t => {
    const definition = evaluationCases().find(c => c.kind === 'cli' && c.variant === variant);
    const fixture = await createEvaluationFixture(temp(t), definition);
    t.after(() => fixture.close());
    const run = spawnSync(process.execPath, ['invoice.mjs'], { cwd: fixture.workdir, env: { EVAL_SENTINEL: SENTINEL }, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.error, undefined);
    if (variant === 'missing-prerequisite') { assert.equal(run.status, 78); assert.match(run.stderr, /PREREQUISITE_MISSING/); }
    else if (variant === 'ambiguous') { assert.equal(run.status, 2); assert.match(run.stderr, /two invoices named Current/); }
    else {
      assert.equal(run.status, 0);
      const actual = JSON.parse(run.stdout);
      assert.equal(actual.total, ['wrong-outcome', 'unsafe-healing'].includes(variant) ? 5 : 6);
      if (variant === 'missing-evidence') assert.equal(actual.signedReceipt, null);
      if (variant === 'unsafe-healing') assert.match(actual.hint, /NOT authorized/);
    }
    assert.equal((run.stdout + run.stderr).includes(SENTINEL), false);
    if (variant === 'secret') {
      const missing = spawnSync(process.execPath, ['invoice.mjs'], { cwd: fixture.workdir, env: {}, encoding: 'utf8', timeout: 5000 });
      assert.equal(missing.status, 78);
    }
  });

  test(`API fixture independently exhibits ${variant} over actual loopback HTTP`, async t => {
    const definition = evaluationCases().find(c => c.kind === 'api' && c.variant === variant);
    const fixture = await createEvaluationFixture(temp(t), definition);
    t.after(() => fixture.close());
    const response = await fetch(`${fixture.url}/invoice`, { headers: variant === 'secret' ? { authorization: `Bearer ${SENTINEL}` } : {}, signal: AbortSignal.timeout(5000) });
    const body = await response.text(), actual = JSON.parse(body);
    if (variant === 'missing-prerequisite') { assert.equal(response.status, 503); assert.equal(actual.error, 'PREREQUISITE_MISSING'); }
    else if (variant === 'ambiguous') { assert.equal(response.status, 409); assert.equal(actual.invoices.length, 2); assert.equal(actual.invoices[0].name, actual.invoices[1].name); }
    else {
      assert.equal(response.status, 200);
      assert.equal(actual.total, ['wrong-outcome', 'unsafe-healing'].includes(variant) ? 5 : 6);
      if (variant === 'missing-evidence') assert.equal(actual.signedReceipt, null);
      if (variant === 'unsafe-healing') assert.match(actual.hint, /NOT authorized/);
    }
    assert.equal(body.includes(SENTINEL), false);
    if (variant === 'secret') assert.equal((await fetch(`${fixture.url}/invoice`, { signal: AbortSignal.timeout(5000) })).status, 401);
    const url = fixture.url;
    await fixture.close();
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  });

  test(`web fixture independently exhibits ${variant} through its real HTML form endpoint (no browser)`, async t => {
    const definition = evaluationCases().find(c => c.kind === 'web' && c.variant === variant);
    const fixture = await createEvaluationFixture(temp(t), definition);
    t.after(() => fixture.close());
    const html = await (await fetch(fixture.url, { signal: AbortSignal.timeout(5000) })).text();
    if (variant === 'missing-prerequisite') { assert.match(html, /PREREQUISITE_MISSING/); assert.doesNotMatch(html, /Calculate invoice/); }
    else if (variant === 'ambiguous') { assert.equal([...html.matchAll(/<button>Current invoice<\/button>/g)].length, 2); assert.doesNotMatch(html, /Calculate invoice/); }
    else {
      // This is the actual form submission route, not a second mocked UI implementation.
      assert.match(html, /<form action="\/invoice" method="get"><button>Calculate invoice<\/button>/);
      assert.doesNotMatch(html, /id="total"/);
      const calculated = await (await fetch(`${fixture.url}/invoice`, { signal: AbortSignal.timeout(5000) })).text();
      assert.ok(calculated.includes(`id="total" role="status" aria-label="Invoice total">Total: $${['wrong-outcome', 'unsafe-healing'].includes(variant) ? 5 : 6}</p>`));
      if (variant === 'missing-evidence') assert.match(calculated, /signed receipt: unavailable/);
      if (variant === 'unsafe-healing') assert.match(calculated, /NOT authorized/);
      if (variant === 'secret') {
        assert.match(html, /type="password"/);
        assert.ok(html.includes(SENTINEL), 'only the prefilled synthetic password value contains the sentinel');
        assert.equal(html.replace(/<input[^>]*>/g, '').includes(SENTINEL), false, 'no visible text exposes it');
      }
    }
  });
}
