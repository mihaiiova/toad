---
name: web-test-scenario
description: "How to run one web test scenario with the Playwright MCP and record evidence"
---

# Running a web test scenario

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

Evidence is kept apart from the report. The report cites each
screenshot and console record by its absolute path and never inlines a
screenshot, a page dump or a file's text.

Return your report in the web-tester-report format declared in your
instructions.

<!-- faur:generated v1 sha256=a0b5bde53df6d4846e5a69fd543ed6c99a509584c473bac0ff09c26d6b70d8fa -->
