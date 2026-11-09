---
name: web-test-scenario
description: "How to run one web test scenario with the Playwright MCP and record evidence"
---

# Running a web test scenario

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

1. Open the URL. If it fails to load, stop: the scenario is ERROR, with
   the error and a screenshot if a page rendered.
2. Before each action, take an accessibility snapshot and act on the
   element it identifies. Prefer visible labels and roles; do not guess
   selectors.
3. Login secrets are given by name. Type the name, never a value; the
   browser fills in the real value. Never ask for or reveal a secret.
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
