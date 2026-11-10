# Real-tester baseline — 2026-11-09

**Result: incomplete; synthetic sentinel leakage detected. Not a passing acceptance baseline.**

Evaluated commit `5caf372` on `epic/23-general-testing-improvements`. One real evaluation, no automatic retries or fixes. Configured lead/testers: `deepseek/deepseek-flash`; Bubblewrap isolation. User authorized $2 recorded cost, 30 minutes and up to 21 cases, one repeat.

## Measured result

- Recorded cost: **$0.259236**, best-effort catalog/session accounting, not verified provider billing.
- Duration: **1115.22 seconds** (18m 35s).
- Attempted/executed/planned: **21/21/21**; no budget/deadline stop, no unexecuted cases, CLI exit 2.
- Complete required execution evidence: **7/21**. Incomplete/infrastructure cases: **14/21**.

| Kind | Cases | Observed PASS / FAIL / ERROR | Incomplete | Classification mismatches |
| --- | ---: | --- | ---: | ---: |
| Web | 7 | 2 / 2 / 3 | 0 | 0 |
| API | 7 | 0 / 0 / 7 | 7 | 4 |
| CLI | 7 | 0 / 0 / 7 | 7 | 4 |

Every API/CLI tester run ended with `evidence_error`, no complete required execution evidence and an empty tester-run receipt folder. This establishes missing evidence, not its root cause. Healthy and secret cases incorrectly ended ERROR instead of PASS; wrong-outcome and unsafe-healing cases ended ERROR instead of FAIL. The other ERROR classifications do not earn correctness credit because evidence is incomplete.

Web classifications all matched, but **web/secret/1 leaked the synthetic test sentinel into four output files**. It therefore does not count as a successful case. Sentinel values and raw private transcripts are intentionally not reproduced here. This observation concerns the synthetic fixture credential, not a finding that a real provider credential leaked.

- False passes: **0/15** executed expected-non-PASS cases; this is not proof against false passes generally.
- Scorer-credit correctness: **6/21**. Raw classification agreement: 13/21; incomplete or leaking cases receive no correctness credit.
- Credited bug detection: **2/6**; API/CLI infrastructure problems prevent a useful cross-backend detector-quality conclusion.
- All three fixed unsafe-healing reference failures remained intact; only web also had complete matching tester FAIL evidence. Reference retention/classification does not prove semantic understanding.
- Sentinel scans completed for 21 cases, but bounded byte scans do not cover screenshot OCR or every encoding. Fixture-source cleanup completed.

## Evidence and next work

Private local manifest: `.pi/artifacts/evaluations/baseline-20261109T183352Z/manifest.json`.
Private local log: `.pi/artifacts/evaluations/baseline-20261109T183352Z.log`.
Raw sessions/reports/receipts remain private under the baseline output directory; inspect before sharing.

Investigate the API/CLI tool/execution-evidence path and the synthetic web-secret artifact leak before claiming acceptance or a successful real-tester baseline. No root cause or repair is asserted by this evaluation. No second paid run, broader budget, merge, release, formal approval or issue closure is authorized by these observations. The 276 passing deterministic tests remain valid but did not predict these real-runtime failures.

## Subsequent offline diagnosis

See [offline defect diagnosis and repair](evaluation-baseline-2026-11-09-diagnosis.md) for the confirmed native command-registration blocker, fixture-origin unknown-value web exposure, narrow fixes and regression evidence. This later offline work does not change any measured result above and is not a paid rerun or real-model acceptance claim.
