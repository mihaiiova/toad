# Structured CLI assertion tool

`node tools/toad-structured-cli.mjs REQUEST` reads one JSON request from the
file named by `REQUEST` (or from stdin when it is omitted). Run it from the Toad
agent directory, after `toad-exec.mjs prepare` has returned a scenario ID.
Example (replace the scenario ID and receipt folder):

```json
{"scenario":"SCENARIO-ID","receipts":"data/receipts/example","name":"01-check-version","program":"node","args":["--version"],"expect":{"exitCode":0,"stdout":{"contains":"v22"}}}
```

`expect.stdout` must contain exactly one string property, `equals` or
`contains`. Equality compares the complete UTF-8 stdout, including final
newlines; containment is literal, case-sensitive and must be nonempty. The tool
passes the program and each argument as a separate quoted shell word to the
existing scenario runner. It retains the runner's workspace, sandbox, timeout
and receipt behavior. The runner's normal human-readable interface is
unchanged; `TOAD_EXEC_JSON=1` selects its machine-readable execution outcome.

The result is one JSON object: `status` is `pass`, `fail` (an assertion did
not match), or `error` (invalid request, unsupported credentials, timeout,
truncated output, or infrastructure failure). Successful execution includes
individual `checks`, actual exit code and stdout, and the receipt path. An
error may include a receipt path when the runner created one. Exit codes are
0, 1 and 2 respectively; a program's nonzero exit is not automatically a test
failure if it is the expected exit. Output exceeding the runner's capture
limit of 2 MiB per stream (including stderr) is an error, never a passing
partial match.

## Recording a covered scenario

Add `capture` to ask for a run-local recording of a scenario that this single
command covers in full:

```json
{"scenario":"SCENARIO-ID","receipts":"data/receipts/example","name":"01-check-version","program":"node","args":["--version"],"expect":{"exitCode":0,"stdout":{"contains":"v22"}},"capture":{"scenarioName":"Node version","complete":true}}
```

`capture.scenarioName` must be the scenario's exact name, and `complete` must
be `true`. Only set it when this one program invocation and its exit-code and
stdout assertion cover every step and the whole expected outcome; otherwise
use the shell tools. A capture happens only when the assertion passes, the
request came from a run that allows recording (`TOAD_RECORDING_ENABLED=cli-v1`,
set by Toad for eligible CLI runs), and the scenario's own PASS is confirmed
when the run finishes. The response then carries `"captured": true`; a `false`
value or a failed scenario never changes the test verdict.

`captured` means only that Toad wrote the candidate file next to the receipt.
It is not a recording yet: the run finalizes it at the end, and only when the
scenario passed, the intent still matches, and the receipt proves the same
command, expected exit code and stdout assertion. A candidate that does not fit
Toad's recording limits (16 KiB in total, or a 4096-character action or
assertion) is not written, so `captured` is `false`; the test still runs.

The command must be the scenario's only receipt: give it the only name in that
scenario's receipt subfolder. Toad discards a candidate when the scenario
folder holds anything else, so keep diagnostics in another scenario's folder
or leave them out.

This is not a recorder, an agent tool registration, or an API testing tool.
It supports one command, no stdin, no shell pipeline interpretation, no
variables shared between commands, and no credential fields or references.
It accepts a project credential selector only if it safely names a regular
file containing an empty JSON object; nonempty, malformed or unsafe project
stores are rejected. Without a project selector it rejects a nonempty legacy
credential store. It invokes the runner with its own empty credentials file. It
cannot identify arbitrary secret values supplied as literal arguments, expected
output or program output. Callers must use trusted, explicitly non-secret test
data; commands and output are written to receipts and a recording stores the
program, arguments and expected stdout as written. Do not use this tool to
handle secrets, and treat artifacts as sensitive. Programs can themselves
interpret arguments or access their environment; sandboxing is not a
substitute for trusting the workload. `--sandbox none` remains explicitly
unsandboxed, exactly as with the underlying runner.

`replayCliPayload` in `toad-cli-recording.mjs` runs a recorded payload in a
fresh workspace without a model, using the payload's own assertion, and returns
PASS or FAIL with the observed exit code and stdout. It drops an inherited
`TOAD_BASE_SCENARIO`, `TOAD_CLI_PATH`, credential selector or recording switch,
because none of those belong to the recording, and keeps an explicit
`TOAD_CLI_SANDBOX` choice.

## Project evidence

Supply `scenarioName` with the exact declared scenario name even when not
capturing (`capture.scenarioName` also binds it). CLI exit/stdout checks and API
status/body checks use the existing sandbox runner and shared run-local execution
records outside receipt folders. Operation completion and machine assertions are
distinct. For exploratory shell commands, cite returned execution IDs in an
explicit `cli_attest_scenario` request; missing completion is ERROR. Required
receipt failure cannot turn a would-be pass into PASS or erase observed FAIL.
