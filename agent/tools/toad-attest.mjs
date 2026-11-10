#!/usr/bin/env node
/** Explicit CLI/API tester completion, not a machine assertion or receipt parser. */
import { readFileSync } from 'node:fs';
import { attestScenario } from './toad-execution.mjs';
try {
  const raw = readFileSync(process.argv[2] ?? 0);
  if (process.argv.length > 3 || raw.length > 16384) throw new Error();
  const request = JSON.parse(raw);
  if (!request || Object.keys(request).sort().join(',') !== 'executionIds,result,scenarioName') throw new Error();
  console.log(JSON.stringify(attestScenario(process.env, request)));
} catch {
  console.log(JSON.stringify({ status: 'error', error: 'Provide the exact scenarioName, PASS/FAIL/ERROR and 1-9 completed executionIds from this scenario. PASS cannot override machine failure.' }));
  process.exitCode = 2;
}
