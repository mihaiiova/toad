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
   fails. Save it in the receipts folder you were given, as
   `<receipts folder>/<scenario-slug>-<NN>-<what-it-shows>.png`, and
   record the path the tool returns.
6. A failed expectation is FAIL. Something that prevented testing (an
   unreachable site, a missing secret, an ambiguous step) is ERROR.
   Note console errors that appear during the scenario.
7. Close the browser when done.

Report, in this order: the scenario name; PASS, FAIL or ERROR; each
step with what you did, what you expected, what you saw, and its
screenshot paths; console errors; and for a FAIL, the first step that
failed and why.

<!-- forge:generated v1 sha256=d347098885b0466b847c23eae6be2d46cfb5267902398d67636942ad7eb770ee -->
