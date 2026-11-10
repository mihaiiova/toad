---
name: web-test-scenario
description: "How to run one web test scenario with the Playwright MCP and record evidence"
---

# Running a web test scenario

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


The handoff's target URL is authoritative. Resolve root-relative paths against
that URL, never an older URL. For structured execution prefer `goto` paths
such as `/pricing`; the tool binds them to the effective run target and refuses
off-target navigation. Use target-relative paths when describing reusable
scenarios. Do not rewrite expected text to make an assertion pass.

In instrumented project runs, FIRST call `browser_toad_bind_scenario` with
`scenarioName` copied exactly from the request. Bind once per tester/browser
session; never reuse a session for a different scenario. For a goal-only request,
provide the explicit bounded scenario name you derived. Binding errors are ERROR,
not product FAIL. If this tool is absent (direct/legacy launch), proceed normally.
A successful browser tool operation is not a scenario assertion; report your
observed conclusions as tester-attested and cite the evidence. For the structured
web command, always supply `scenarioName` (or the same exact name in capture).

For the native tool argument `request`, supply the serialized JSON object
below as text. Do not include a filename, shell command, Markdown fences or
literal `JSON.stringify(...)`. Replace placeholders with actual request values;
keep the object serialized inside the string-valued `request` argument.

```json
{"receipts":"RECEIPTS","name":"01-check","scenarioName":"EXACT_NAME","payload":{"steps":[{"action":"goto","url":"/"},{"action":"expectText","target":{"role":"heading","name":"Invoice"},"contains":"Invoice"}]}}
```

Use only supported actions and actual observed locators/expected literals.
The example is illustrative, not permission to change the scenario intent.

1. Open the URL. If it fails to load, stop: the scenario is ERROR, with
   the error and a screenshot if a page rendered.
2. Before each action, take an accessibility snapshot and act on the
   element it identifies. Prefer visible labels and roles; do not guess
   selectors.
3. Login secrets are given by name. Type the name, never a value; the
   browser fills in the real value. Never ask for or reveal a secret.
   Selected registered values can be redacted by the native browser transport;
   unknown/unselected page values, screenshots and arbitrary encodings are not
   automatically protected. Do not probe password values or persist page dumps
   containing sensitive content. Report missing selected references as ERROR.
4. After each step, check the expected outcome against the snapshot.
   Wait for content that loads late before deciding.
5. Take a screenshot at each checkpoint, and always at the moment a step
   fails. Save it as
   `<receipts folder>/<scenario-slug>/<NN>-<what-it-shows>.png`, numbering
   from 01, and record the path the tool returns. That folder holds this
   scenario's screenshots and console records and nothing else; never
   copy them elsewhere, including into the project under test.
6. A failed expectation is FAIL. Something that prevented testing (an
   unreachable site, a missing secret, an ambiguous step) is ERROR.
   Note console errors that appear during the scenario.
7. Close the browser when done.
8. When the request says recording is on and the whole scenario is an
   ordered sequence of opening pages, clicking, filling and explicit
   checks, run it once with cli_run_structured_web as the request
   describes: stable role, label or text locators, trusted non-secret
   literals, a check at the end, and capture with the exact scenario
   name and complete true only when those steps and checks cover every
   step and expected outcome. It runs in a fresh browser and records
   its own receipt; cite that path. Never use it for sign-in, password,
   token or other credential fields, and never weaken a scenario to
   record it; otherwise use the browser tools.

Evidence is kept apart from the report. The report cites each
screenshot and console record by its absolute path and never inlines a
screenshot, a page dump or a file's text.

Return your report in the web-tester-report format declared in your
instructions.

<!-- faur:generated v1 sha256=a0b5bde53df6d4846e5a69fd543ed6c99a509584c473bac0ff09c26d6b70d8fa -->
