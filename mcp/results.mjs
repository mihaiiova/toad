/**
 * Reading a Toad report: the overall verdict and each scenario's result.
 */

/**
 * The report's verdict: PASS, FAIL or ERROR, or UNKNOWN when it has none. The
 * bot is told to start with `Verdict: X`; headings or bold around the word
 * Verdict, and the value on the next line, are accepted too.
 */
export function verdictOf(answer) {
  return /^[#*\s]*Verdict[*:\s]*?(?:\n\s*)*[*\s]*(PASS|FAIL|ERROR)\b/im.exec(answer ?? '')?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

/**
 * Each scenario's result, from the report's `Results:` block:
 * `- PASS | name` lines. Empty when the report has no block.
 */
export function resultsOf(answer) {
  const lines = (answer ?? '').split('\n');
  const start = lines.findIndex(line => /^[#*\s]*Results[*:\s]*$/i.test(line));
  if (start < 0) return [];
  const results = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { if (results.length) break; continue; }
    const m = /^\s*[-*]\s*\**(PASS|FAIL|ERROR)\**\s*\|\s*(.+?)\s*$/i.exec(line);
    if (!m) break;
    results.push({ name: m[2].replace(/^[`"]|[`"]$/g, ''), result: m[1].toUpperCase() });
  }
  return results;
}

/**
 * Match reported results to the requested scenarios by name. A requested
 * scenario the report left out is ERROR: silence is never a pass.
 */
export function scenarioResults(requested, reported) {
  // No block at all (an older agent): results are unknown, not ERROR.
  if (!reported.length || !requested?.length) return reported;
  const byName = new Map(reported.map(r => [r.name.trim().toLowerCase(), r.result]));
  return requested.map(s => ({ name: s.name, result: byName.get(s.name.trim().toLowerCase()) ?? 'ERROR', ...(byName.has(s.name.trim().toLowerCase()) ? {} : { missing: true }) }));
}

const RANK = { PASS: 0, ERROR: 1, FAIL: 2 };
/**
 * The run's verdict, kept consistent with its scenarios: FAIL if any scenario
 * failed, otherwise ERROR if any errored, otherwise the report's own verdict.
 */
export function overallVerdict(verdict, scenarios) {
  if (!scenarios.length) return verdict;
  const worst = scenarios.reduce((w, s) => RANK[s.result] > RANK[w] ? s.result : w, 'PASS');
  if (verdict === 'UNKNOWN') return worst;
  return RANK[worst] > (RANK[verdict] ?? -1) ? worst : verdict;
}
