---
name: cli-test-scenario
description: "Run one CLI scenario and record its evidence"
---

# Running a CLI test scenario

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
4. Compare recorded exit codes and output with the expected outcomes.
   A failed expectation is FAIL; missing dependencies, sandbox errors,
   missing secrets or ambiguous steps are ERROR. Do not infer success.
5. Secrets are referenced by environment variable name, never value.
   Return a scenario report with the verdict, observed steps and absolute
   receipt paths, without inlining receipt contents or logs. For FAIL,
   identify the first failing step and why.

<!-- forge:generated v1 sha256=f43a8d6e5eade1d3019fc5a86f0f71c3062dd6967f0a04454c53b4968ff31794 -->
