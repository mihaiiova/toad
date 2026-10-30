---
name: cli-test-scenario
description: "How to run one command-line test scenario and record evidence"
---

# Running a command-line test scenario

Every command goes through run-command (or run-command-with-input when
the program reads from its input). Each call records the command, its
exit code, its output and its duration as a receipt.

1. Use the working folder you were given for every command. The
   receipts folder is an absolute path that belongs to Revisor, not to
   the project under test: pass it to the command tool exactly as
   given, and never create, copy or mirror receipts anywhere else.
   Name each command `<scenario-slug>-<NN>-<what-it-does>`, numbering
   from 01. Run only the commands the scenario needs.
2. Check the program can run first (for example `<program> --version`
   or `--help`). If it can't, the scenario is ERROR.
3. Run each step as written. Check the expected outcome against the
   exit code, the output and any files the step should create;
   inspect files with commands such as `ls`, `cat` or `test -f`.
4. Write files only inside `<receipts folder>/<scenario-slug>-work/`,
   unless the scenario says to change the project. Never run commands
   that delete or change anything outside those two places.
5. Commands get no input and stop after a timeout. Give input with
   run-command-with-input; never start an interactive program without
   it.
6. Login secrets are environment variables, by name: write `$NAME` in
   the command, never a value. Output shows them as `[secret:NAME]`.
7. A failed expectation is FAIL. Something that prevented testing (the
   program is missing, a secret is missing, a step is ambiguous) is
   ERROR. A non-zero exit code is a failure only when the scenario
   expected success.

Report, in this order: the scenario name; PASS, FAIL or ERROR; each
step with the command, what you expected, what you saw (exit code and
the relevant output) and its receipt path; and for a FAIL, the first
step that failed and why.

<!-- forge:generated v1 sha256=46eae28e7d852951595bc6a9919ecd55c1edc5a6c0a6ed31f002e07d57c747ae -->
