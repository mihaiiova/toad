# Epic #23 stacked implementation checkpoint

Branch: `epic/23-general-testing-improvements`, based on #24 checkpoint `7592989`.

## Implemented remaining scope

- **#25:** attributed CLI/API operation evidence and typed assertions, evidence-linked exploratory completion, authoritative failed assertions across investigation/exporters, and retirement of legacy public MCP tools. Use `setup_project` + `run_project_test`.
- **#26:** readable current recording payloads, source-aware secret-safe definition diagnostics, static invalid-recording preflight, minimal original-target provenance, ordered action/assertion diffs, and snapshot-bound proposal acceptance. Current executable codec formats remain bounded and unchanged.
- **#27:** explicit sandbox-backed before/after attempt hooks with native workspace ownership, named scenarios, aggregate run budget, separate bounded cleanup, writes/credential gating, required evidence and no hook-bearing capture/replay.
- **#28:** 21-case local web/API/CLI fixture set, deterministic scorer, explicit budgeted `toad evaluate` command, independent unsafe-healing reference replay, and reproducible manifests. Fake-Pi execution measures harness behavior, not real tester quality.

Implementation and validation used one writer at a time. Tests were added during implementation but executed only after all four implementation stages, per the approved batch amendment. No issue was closed, no branch merged or pushed, and no release/version bump performed.

## Final executed validation

- Affected public-seam tests: **190/190 passed**, zero failed/skipped/cancelled.
- `npm test`: **276/276 passed**, six suites, zero failed/skipped/cancelled/todo; includes predecessor web evidence regressions and the installed-browser structured replay test.
- `npm pack --dry-run --json`: passed, **58 packaged files**.
- Explicit package inspection: all eight new production helper/fixture modules and 105 static relative references resolve in the inventory; runtime evaluation fixtures are embedded/generated from the packaged fixture module, not excluded test files.
- Narrow source/native command/tool alignment check: passed without blanket Faur regeneration.
- `git diff --check`: passed.

Full command/failure/rerun logs and the package inventory are local ignored artifacts under `.pi/artifacts/spec-start/epic-23-*`. Earlier fixture-wiring and contract failures were retained in those logs, fixed without dropping assertions, and followed by successful affected/full reruns. The initial unsafe-healing web fixture used an invalid relative initial URL; the fixed reference uses its actual absolute fixture target without relaxing codec restrictions. Failed structured capture now explicitly reports `captured: false`.

## Approved implementation details

- CLI/API execution records are versioned alongside existing web records; raw commands/results are not copied into shared metadata as implicit assertions. Exploratory completion cites durable execution IDs.
- Failed saved assertions remain FAIL even if later investigation passes or a proposed replacement is explicitly accepted. Investigation evidence can remain a separate passing execution for capture proofs; aggregate results retain original replay failure and provenance. Acceptance cannot rewrite historical run outcomes.
- Malformed/unsafe/unknown recordings fail preflight. Valid context staleness can use the agent, but an out-of-current-target legacy recording without sufficient original-target provenance requires review/re-recording. One sibling recording-context file per suite supplies minimum trusted provenance, not tamper-proof attestation.
- Proposal acceptance checks saved-file baseline, intent/context and validated proposal, with cooperative locking and individual atomic publication. Old insufficient-provenance proposals need regeneration/review; this is not a multi-file filesystem transaction.
- Hook-bearing handoffs require explicit named scenarios. CLI/API hooks share the target workspace; web requires an explicit fixture workdir and gains no shell tools. Hook credentials default empty and must be selected permitted application references. Effective hook writes cannot bypass suite approval. Disposable workspaces and external reset/idempotency responsibilities are documented.
- Unsafe-healing reference replay establishes independent original-assertion ground truth. A matching tester FAIL plus retained reference demonstrates classification/retention, not proof that the model understood or evaluated the exact same assertion.
- Benchmark fixtures stay loopback-only. Actual benchmark preflight refuses container/auto-to-container mode before startup/spend; explicit Linux Bubblewrap or explicitly acknowledged no-isolation mode in trusted disposable environments is required. Ordinary Toad container support is unchanged.

## Pending verification and limits

**The paid real-tester web/API/CLI baseline has not run.** It requires separate model, cost, time and scenario authorization. No actual tester accuracy or real-model safety claim follows from offline/fake-Pi tests.

Independent/formal review and integration remain pending. The GitHub specs remain in progress, not accepted/done. Validation was on Linux/Node 22 with available backends/browser; it does not establish a new macOS/Windows support matrix. Existing trusted-agent/filesystem limits, cooperative-lock assumptions, process-stop grace, best-effort cost accounting, bounded non-OCR secret scans and inability to guarantee cleanup after hard kill/power loss remain. Generated marker reconciliation remains tracked separately in #22.
