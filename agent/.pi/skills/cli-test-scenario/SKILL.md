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
   Commands run with `/bin/sh`, not bash: use POSIX shell only (no
   `${PIPESTATUS[@]}`, `[[ ]]`, arrays or `source`), or run
   `bash -c '...'` when the image has bash.
4. Compare recorded exit codes and output with the expected outcomes.
   A failed expectation is FAIL; missing dependencies, sandbox errors,
   missing secrets or ambiguous steps are ERROR. Do not infer success.
5. If a step fails because a program, package or module it needs is
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
6. Secrets are referenced by environment variable name, never value.
   Return a scenario report with the verdict, observed steps and absolute
   receipt paths, without inlining receipt contents or logs. For FAIL,
   identify the first failing step and why.

<!-- faur:generated v1 sha256=5fd1d3a74c5943188d11b2ec2b7bbdfb58eb0f5e55636b54d916e635e8a0a995 -->
