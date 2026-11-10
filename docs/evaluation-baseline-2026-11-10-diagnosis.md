# Luna rerun: offline diagnosis and narrow repairs

The [2026-11-10 measured rerun](evaluation-baseline-2026-11-10.md) remains **incomplete**, with its original 11/21 credited correctness and ten `evidence_error` outcomes unchanged. No further paid calls, installs, sandbox downgrade, model substitution or historical re-scoring occurred during diagnosis. Retained sessions/manifests/receipts were not edited.

## Attribution of all ten evidence errors

| Cases | Confirmed immediate cause | Disposition |
| --- | --- | --- |
| `web/healthy/1`, `web/unsafe-healing/1` | Structured web tool's `request` argument was not JSON text. Scenario binding alone is not operation evidence. | Correct pre-execution refusal, not a browser/reader failure. |
| `api/healthy/1` | Lead explicitly delegated with `cwd=/tmp`; project-scoped discovery could not find `api-tester` there. | Model invocation violated the existing no-`cwd` instruction. Discovery succeeds in the prepared agent directory. |
| `api/wrong-outcome/1`, `api/missing-prerequisite/1`, `api/missing-evidence/1` | Structured API payloads used null/absent required `body`; two also used uppercase `Accept` instead of supported lowercase headers. | Correct strict-schema refusal before HTTP execution. Correcting one invalid field does not excuse another. |
| `cli/healthy/1`, `cli/missing-prerequisite/1` | Structured CLI requests invented fields such as `expectedExitCode`/`expectedStdout` instead of `expect`; retries also used unsupported shapes. The missing-prerequisite fallback then supplied a workspace path instead of the returned UUID. | Correct refusal; fallback identity diagnostic was misleading and is repaired below. |
| `cli/ambiguous/1`, `cli/missing-evidence/1` | Complete linked operation evidence plus valid explicit `ERROR` attestation was treated as infrastructure failure merely because the attestation outcome was `ERROR`. | Confirmed aggregation defect, repaired below. |

Eight cases have no readable execution records. Seven have no reader errors; the CLI missing-prerequisite fallback has an explicit binding-error marker, not a stored record lost by the reader. Successful siblings prove that native registration, browser operations, shell fallback and attestation were available. The prepared variant's relevant commands, scripts and extensions match the checkout; tester declarations differ by selected model.

## Deterministic feedback loops

All probes use synthetic shapes or emit structural metadata only; private raw argument/result values and sentinel values are not published.

1. A retained-evidence probe calls the actual `readExecutionRecords` and reproduces all ten observed evidence errors. Original measurements are immutable; this forensic probe intentionally remains red after repairs and is not a test of new execution behavior.
2. Actual installed pi-commands registration/execute plus malformed synthetic structured inputs reproduces native `isError` and zero records for web/API/CLI in seconds. These are correctly refused requests, not a regression requirement to execute invalid input or fabricate operation evidence. No product/browser/sandbox execution or model call is needed.
3. Actual project-scoped agent discovery changes only `cwd`: `/tmp` lacks the specialist; the prepared agent directory discovers it. No LLM execution.
4. A public `runProject` fake-Pi probe with real execution writer/reader/attestation changes only the conclusion: PASS and FAIL are `status:ok`, but ERROR was `status:evidence_error`. Missing evidence remains separately reproducible. This is harness-only aggregation evidence, not model quality.
5. A native CLI fallback probe changes only the scenario argument from a path to a syntactic UUID. The path incorrectly produced a name-binding message. The UUID produces a durable ERROR for an intentionally nonexistent workspace; it never runs a product command.

The ranked hypotheses were rejected-input/delegation path, ERROR-conclusion aggregation conflation, and reader/attribution loss. The first two explain the cases; no reader loss of already persisted operation records was found.

## Repairs and regression evidence

### Fully evidenced ERROR conclusions

`mcp/run.mjs` now distinguishes a completed, fully evidenced `attestScenario` record with agent verification and matching `agentAttestation:ERROR` from an operation/machine-assertion infrastructure ERROR. The verdict remains **ERROR**, not PASS. Goal-only CLI/API reconstruction accepts a completed ERROR/FAIL conclusion instead of demanding PASS just to consider the workflow complete.

The exception does not excuse missing receipts/linked evidence, unfinished operations, real operation ERROR, machine assertion ERROR or optimistic prose. Observed FAIL remains primary. No changes to fixture expectations, scorer rules or historical runs.

New `mcp/test/attestation-completion.test.mjs` exercises the actual public `runProject` seam with real durable record/attestation helpers. It covers CLI/API PASS, ERROR, FAIL, missing evidence, receipt loss, operation ERROR, unfinished operations, machine ERROR/FAIL, optimistic prose and goal-only reconstruction; a fully evidenced expected ERROR can earn deterministic scorer credit without becoming PASS. Before repair, four ERROR/goal-only subcases failed. After repair and review follow-up all 27 test entries pass, including explicit goal-only attested FAIL and machine FAIL regressions; the original minimized aggregation probe passes too. The existing `runEvaluation` → `observeEvaluationCase` fake-Pi harness now writes actual ERROR attestations for expected-error CLI/API cases and asserts their real normalized observation/scorer mapping, rather than only synthesizing scorer inputs.

### Scenario identity diagnostic

`toad-exec.mjs` rejects malformed execution identity before assigning it as session/attempt ID. The fixed message requests the UUID returned by prepare, not a workspace path or scenario name. Invalid binding still creates the fail-closed marker and runs no product command. A regression in `cli-api-execution.test.mjs` was red on the old misleading name-binding message and is now green. UUID/path confinement and sandbox lookup remain enforced.

### Agent-facing request guidance

CLI/API/web scenario skills now include compact native tool-call examples: `request` is JSON **text**, not a filename or shell command; CLI uses `program`/`args`/`expect`, API includes all required payload keys with `body:""` for no body and lowercase headers. Returned workspace UUID and exact scenario name are distinct. Examples explicitly preserve the real requested intent. Authored `system.yaml` and all three native skill bodies match; no blanket regeneration or permissions/model changes.

These examples address an interface affordance: the native command schema exposes a request string, while testers cannot freely read tool documentation files. They do not prove the model will follow instructions in a future run. The existing lead instruction forbidding specialist `cwd` overrides remains unchanged; no sandbox or project-discovery bypass was added.

## Executed validation and limits

- `node --test mcp/test/attestation-completion.test.mjs`: red before fix, **27/27 green** after.
- `node --test --test-name-pattern='workspace path used as scenario ID' mcp/test/cli-api-execution.test.mjs`: red before fix, green after.
- `node --test mcp/test/attestation-completion.test.mjs mcp/test/cli-api-execution.test.mjs mcp/test/evaluation.test.mjs`: **43/43 pass**.
- Full `npm test` with explicit installed pinned Playwright MCP/Chromium paths and `npm_config_offline=true`: **310/310 pass, zero skipped**, Linux/Node 22.
- Source/native scenario skill body comparison and `git diff --check`: pass.

Logs/probes are local private debugging artifacts under `/tmp/toad-epic-audit/` and `/tmp/toad-luna-diagnosis/`; they are not shipped runtime dependencies. No temporary debug logging was added to production code. Independent focused review completed with no blockers. Its notes led to explicit goal-only FAIL tests, actual evaluator-seam ERROR coverage and literal JSON examples with a warning not to send `JSON.stringify(...)` as request text. The reviewer did not execute tests; the supervisor executed the final 43 targeted and 310 full tests above. No issue transition, integration, release or paid rerun is implied. A new authorized real run is needed to measure post-repair model behavior; do not retroactively turn the original incomplete measurement into a successful baseline.
