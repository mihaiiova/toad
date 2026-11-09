# Spec #24 implementation clarification

The ordinary Playwright MCP process inherits run-wide environment, not the
individual tester's scenario identity. Attribution must not be guessed from
transcripts, tool arguments, folder slugs or a retry ordinal.

Supervisor-approved approach: instrumented project sessions expose
`browser_toad_bind_scenario`. The tester calls it first with the exact declared
scenario name, once per owned MCP session. Unknown names and rebinding are
infrastructure errors. Goal-only runs accept a bounded explicit tester-derived
name and mark it derived. Direct/legacy sessions remain unchanged. Canonical
scenario hashes match the existing recording identity; session, attempt and
execution UUIDs are unique, without claiming a numeric retry count.

Structured web requests accept an explicit `scenarioName`, or use the exact
`capture.scenarioName`; existing unique receipt-folder mappings can resolve a
predeclared name but never define a different hash identity. Goal-only structured
requests must provide the name explicitly.

Ordinary operation metadata and mandatory receipts contain tool names and fixed
outcome classifications only, not raw arguments or responses. Typed structured
assertions are separate from successful browser operations. Ordinary raw
hierarchy/console diagnostic persistence is unavailable by privacy policy;
optional screenshots remain sensitive artifacts under the existing receipt
policy. Structured credential-free execution can save bounded hierarchy/console
diagnostics. Failure/cancellation capture happens before process cleanup.

New instrumented project web runs cannot accept a PASS without operation
receipts for the reported scenario. Machine-observed assertion FAIL remains
FAIL even when the agent reports PASS or a required receipt later disappears;
the evidence error is reported separately. Cancellation and cost-limit status
are not replaced by a later evidence-collection error.

End-stage validation: `npm test` passed 201 tests; the affected execution,
server and web-recording suites passed 69 tests. `npm pack --dry-run --json`
passed and includes both execution helper modules; `git diff --check` passed.
The delegated implementation timed out during finalization; the parent inspected
the changes, fixed evidence/protocol edge cases and reran validation. No paid
model calls or real-agent exploratory session was run. Structured web coverage
includes the existing real-browser test; ordinary transport is tested through
the fake MCP subprocess. Formal spec review and integration remain pending.
