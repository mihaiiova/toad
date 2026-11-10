# Toad contributor guide for coding agents

## Project map

- `mcp/`: CLI, project handoffs, suites/replay, execution results, read-only viewer and opt-in evaluation harness.
- `agent/tools/`: sandbox commands, browser transport, structured checks and durable execution evidence.
- `agent/.pi/system.yaml`: authored agent declarations; `agent/.pi/agents/`, skills and `APPEND_SYSTEM.md` are the shipped native instructions.
- `skills/toad-mcp/SKILL.md`: coding-agent handoff/credential guide. See `README.md` for the public contract and `docs/evaluations.md` for benchmark operation.

No blanket Faur regeneration: existing generated/native reconciliation is tracked in #22. For narrow instruction changes, keep source declarations and corresponding native instructions aligned without changing tool allowlists, async specialist behavior or permissions. Generated markers are not proof the files are synchronized.

## Validation

Node >=22.19.0. Run `npm test`, `npm pack --dry-run` and `git diff --check`. Keep npm dependencies pinned. Check package inventory when adding runtime modules: tests/fixtures excluded from packaging cannot be runtime dependencies.

Some integration tests require installed prerequisites and otherwise skip. Native command registration uses the installed pinned pi-commands package. Native browser-secret checks require `TOAD_TEST_PLAYWRIGHT_MCP_CLI` (the shipped pin in `agent/.pi/mcp.json`) and `TOAD_TEST_CHROMIUM_EXECUTABLE` pointing to installed files. See the reproduce-offline section of `docs/evaluation-baseline-2026-11-09-diagnosis.md`. Do not download or run setup just to turn skips green without approval. Report pass/fail/skip counts and environment; fake Pi/browser tests are harness-only, not real-model evidence.

## Evidence and safety invariants

- Preserve FAIL > ERROR > PASS. Machine assertion failure survives investigation/healing and proposal acceptance; only a subsequent reviewed run can pass. Infrastructure failure is ERROR, not product FAIL.
- Missing required operation evidence/completion blocks PASS. Optional diagnostics only warn. Exploratory operation completion is not an assertion: CLI/API conclusions use evidence-linked tester attestation; web conclusions without structured assertions remain tester-reported.
- Execution metadata belongs outside proof-checked receipt folders. Receipts are immutable: unique names for every probe/retry, no overwriting, fabricating proofs or historical backfill.
- Keep scenario, execution, attempt and replay/investigation identities distinct. Shell command tools use `scenario_name`; structured JSON uses `scenarioName`. Native command placeholders must stay lowercase/snake_case.
- Hook attempts have native workspace ownership and ordered prepare/before/product/evidence/after/disposal. Do not bypass hooks with recordings, invent host-shell fallback or weaken writes/credential gates. The default 120-second attempt timeout includes preparation, before commands and product work; cleanup commands get a separate default 30-second budget. Cleanup is best effort, not crash-proof.
- Preserve no-follow/path confinement, recording codec limits and static preflight. Unknown/malformed/unsafe recordings are errors; legitimate context staleness can fall back, never replay against an unjustified target. Keep minimal recording-context provenance with saved suites.
- Secrets are selected env-name references, never handoff literals or printed values. Do not read credentials/auth files to inspect their contents. Treat reports, sessions, screenshots and receipts as private. Unknown page values and screenshot pixels are not universally redacted.
- Public MCP testing uses `setup_project` + `run_project_test`; legacy shared-store web/CLI tools are retired. Discover deployed schemas rather than assuming installed servers match the checkout.

## Paid evaluations and lifecycle

`toad evaluate` requires explicit authorization, lead/tester model IDs, cost/time/scenario caps and a new private output directory. Models must match a prepared agent. Changing models is supported but is not a controlled model-only comparison when fixtures/runtime also change. Do not silently change persistent model defaults, install prerequisites, retry, expand budgets or downgrade the sandbox. Loopback fixtures require supported Bubblewrap or explicitly authorized no-isolation mode, not container networking. Recorded cost is best effort, not a hard billing ceiling.

The first real baseline (`5caf372`, fixture v1) is incomplete: 14 CLI/API evidence failures and one synthetic web-secret leak. Narrow offline repairs and fixture v2 have native integration coverage. The separate 2026-11-10 Luna rerun executed all 21 cases with fixture v2 but remained incomplete (10 evidence errors, 11/21 credited correct, 4/6 bug detection, zero sentinel leaks detected). See `docs/evaluation-baseline-2026-11-10-diagnosis.md` for the subsequent offline attribution/repairs: valid explicit ERROR conclusions are not infrastructure failures; malformed structured requests and wrong specialist cwd remain refused. Native structured tools take JSON text in `request`, not a filename; use the scenario skills' exact supported shape. The post-repair offline suite passed 310/310 with installed native prerequisites, including explicit goal-only FAIL and actual evaluator-seam ERROR-attestation coverage. Neither offline tests nor this incomplete measurement establish general real-model reliability. Preserve both measurements and record each authorized rerun separately. Read the baseline/diagnosis/evaluation docs for current evidence, not just an older implementation checkpoint. No benchmark accuracy threshold is implied by deterministic test success.

Respect user-owned untracked files. Do not close issues, merge, push, release or run paid work merely because tests pass. Record deliberate departures from approved spec requirements on the issue when applicable; do not silently equate implementation with acceptance.
