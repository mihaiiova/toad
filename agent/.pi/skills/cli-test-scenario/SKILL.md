---
name: cli-test-scenario
description: "Run one CLI scenario and record its evidence"
---

# Running a CLI test scenario

When the request supplies a native owned attempt ID, fixture preparation has
already run exactly once. Use that ID for every command; preparation tools
return the same workspace rather than cloning again. Do not run before/after
commands yourself, change workdir, remove the workspace, or retry the scenario
internally. Native finalization owns teardown, including after cancellation.
Collect failure receipts and any available diagnostics BEFORE returning (cleanup
may destroy fixtures). Hook workspaces are disposable, not retained evidence.
Hook-bearing scenarios cannot be recorded or replayed; normal structured
assertions/attestations still apply. Web fixture commands are native sandbox
commands only: they grant no shell tools or browser-cookie/reset scripts to
the web tester. No persistent daemon or remote-state isolation is promised.


In project runs, pass `scenarioName` copied exactly from the requested scenario
on every command (not the workspace UUID). Structured CLI/API requests also take
`scenarioName`; `capture.scenarioName` binds it when recording. For goal-only
runs use an explicit bounded name. Commands return an execution ID. Normal shell
commands and HTTP requests produce operation evidence, not machine scenario
assertions. After comparing observations with every expectation, call
`cli_attest_scenario` with `{scenarioName:EXACT_NAME,result:"PASS"|"FAIL"|"ERROR",
executionIds:[ID,...]}` referencing 1-9 completed operations for that scenario.
This is labeled tester-attested, not machine verified. Missing completion is
ERROR, never PASS. Use structured assertions whenever appropriate, regardless
of recording eligibility; do not weaken expectations to make them pass.
A failed saved assertion stays FAIL after investigation or replacement capture.
Do not use an attestation or report formatting to override a machine failure.

1. Prepare a scenario for the requested project. If the scenario requires
   network access, use the network preparation tool with a non-mutating
   HTTP(S) endpoint. Otherwise use ordinary preparation. An infrastructure
   or preflight error is ERROR; do not run commands on the host instead.
2. Use the returned scenario ID for every command in this scenario. The
   workspace persists across commands and is retained for inspection.
   Each command gets a fresh namespace; background servers do not persist.
3. Check the program is available, then execute the scenario's steps in
   order. Put recorded evidence for one scenario under the supplied
   receipts folder, in a scenario-specific subfolder. Name each command
   NN-what-it-does, numbering from 01. Use the input-enabled command
   when needed. The workspace is scratch space, not evidence.
   Commands run with `/bin/sh`, not bash: use POSIX shell only (no
   `${PIPESTATUS[@]}`, `[[ ]]`, arrays or `source`), or run
   `bash -c '...'` when the image has bash.
4. When one program invocation with explicit arguments covers every step and
   expected outcome of the scenario, use the structured command instead of a
   shell command: it asserts the exit code and stdout itself and, when the
   request says so, may record the scenario. Give it the scenario ID, the
   receipt name, the program and its arguments, and the expected exit code and
   stdout. Also pass the scenario's exact name and mark it complete only when
   that single action and assertion really cover the whole scenario; otherwise
   use the shell tools. It supports trusted, non-secret literal data only, so
   never use it for a scenario that needs credentials, and never weaken a
   scenario to make it recordable. Keep it the scenario's only receipt when
   recording.
5. Compare recorded exit codes and output with the expected outcomes.
   A failed expectation is FAIL; missing dependencies, sandbox errors,
   missing secrets or ambiguous steps are ERROR. Do not infer success.
6. If a step fails because a program, package or module it needs is
   missing ("command not found", "Cannot find module", "is not
   installed"), that is a missing prerequisite, not a product failure:
   record a command that shows it is missing and name it in the report.
   Install it only when the request says installing prerequisites is
   allowed, and then only inside the workspace or $HOME: the rest of
   the filesystem is read-only, so `npm install -g`, `apt-get` and
   `sudo` do not work. Use a local install (`npm install --no-save
   pkg@version`, `pip install --target .toad-deps pkg==version`) and
   put its bin folder first on PATH within the same command (for
   example `PATH="$PWD/node_modules/.bin:$PATH" tool --version`).
   Record the install and the retried step as receipts. If installing
   is not allowed, or the install fails, the step is ERROR.
7. Secrets are referenced by environment variable name, never value.
   Return a scenario report with the verdict, observed steps and absolute
   receipt paths, without inlining receipt contents or logs. For FAIL,
   identify the first failing step and why.

<!-- faur:generated v1 sha256=5fd1d3a74c5943188d11b2ec2b7bbdfb58eb0f5e55636b54d916e635e8a0a995 -->
