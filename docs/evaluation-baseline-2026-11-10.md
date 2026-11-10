# Real-tester rerun — 2026-11-10

**Result: incomplete, not a passing evaluation.** All 21 cases executed; 10 ended with infrastructure/evidence errors. No automatic retry or second evaluation was performed.

## Configuration and scope

- Source HEAD `b10bb9b` with the current documentation/agent-instruction updates in the working tree; this is not an exact clean-commit benchmark.
- Lead and all testers: `openai-codex/gpt-6-luna`; sole observed model identifier matches the requested model.
- Fixture v2, Toad 0.8.0, explicit Bubblewrap isolation, one repeat.
- User-authorized limits: $5 recorded cost, 2700 seconds, 21 attempted cases. Recorded cost is best-effort, not verified billing or a hard provider ceiling.
- Separate prepared agent variant; persistent default models and the original baseline were not changed.

The original [2026-11-09 measurement](evaluation-baseline-2026-11-09.md) used DeepSeek, fixture v1 and earlier runtime/instructions. Both model and implementation/input revisions changed; this is not a controlled model-only comparison or statistical reliability claim.

## Measured results

- Elapsed: **1579.036 seconds** (26m 19s).
- Recorded cost: **$0.085438**; unknown-cost cases: 0.
- Planned/executed/unexecuted: **21/21/0**; stop reason: none.
- **10 incomplete/infrastructure cases**; statuses: 11 `ok`, 10 `evidence_error`; CLI exit **2**.

| Kind | Cases | Observed PASS / FAIL / ERROR | Credited correct | Incomplete |
| --- | ---: | --- | ---: | ---: |
| Web | 7 | 1 / 1 / 5 | 5 | 2 |
| API | 7 | 1 / 1 / 5 | 3 | 4 |
| CLI | 7 | 1 / 2 / 4 | 3 | 4 |
| Total | 21 | 3 / 4 / 14 | 11 | 10 |

FAIL/ERROR can be correct fixture outcomes; raw PASS count is not accuracy. Infrastructure/evidence errors do not establish product failures.

- Credited correctness: **11/21 (52.38%)**; bug detection: **4/6**.
- False passes: **0/15** executed expected-non-PASS cases; no general false-pass guarantee.
- Healthy false FAIL: **0/6**; healthy ERROR: **3/6**; FAIL-versus-ERROR mismatches: **2/15**.
- Complete operation evidence: **13/21**. Evaluation completeness also requires other provenance/verification conditions; this count is not the number of complete evaluation cases.
- Synthetic sentinel leaks detected: **0 cases**, including **0/3** secret cases. The bounded byte scanner does not inspect screenshot pixels/OCR or every encoding.
- Unsafe healing flagged: **0/3**. All three original failed assertion references were verified and retained unchanged. Retention plus a matching classification is not proof of semantic understanding.
- Disposable fixture-source cleanup completed. Private evidence remains retained.

## Evidence and next work

Private manifest: `.pi/artifacts/evaluations/rerun-luna-20261110T135436Z/manifest.json`.
Private normalized summary: `.pi/artifacts/evaluations/rerun-luna-supervisor-summary.md`.
Raw sessions/reports/receipts and the adjacent evaluation log remain private; inspect and sanitize before sharing. No secret values or raw transcripts are reproduced here.

Investigate the ten `evidence_error` outcomes through their execution records and completion/attestation paths before claiming successful runtime verification. This measurement does not establish their root cause. The full offline suite passed 282/282 before this evaluation, but that is not a substitute for real-model evidence.

No additional paid rerun, automatic fix, wider budget, issue closure, merge or release follows from the completed authorization. Preserve both historical measurements unchanged.

## Subsequent offline diagnosis

The separately requested [offline diagnosis](evaluation-baseline-2026-11-10-diagnosis.md) attributes all ten evidence errors: eight rejected/delegation failures and two fully evidenced ERROR conclusions misclassified by aggregation. Narrow aggregation/identity-message repairs and agent-facing JSON examples have offline regression evidence. They do not change the measurements above and are not a new real-model baseline.
