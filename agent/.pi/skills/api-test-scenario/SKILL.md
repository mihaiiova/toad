---
name: api-test-scenario
description: "Run one HTTP API scenario and record every request as evidence"
---

# Running an API test scenario

1. Prepare a scenario with the network preparation tool, passing the API
   URL to use from inside the sandbox (the request says when it differs
   from the API's own URL). Any HTTP answer means the API is reachable;
   a preparation error is ERROR. Never send requests from the host.
2. Use the returned scenario ID for every command. Commands run with
   `/bin/sh`, not bash: use POSIX shell only. The working folder,
   with the OpenAPI description and fixtures, is the current directory.
   When the request names an OpenAPI description, read the parts the
   scenario touches first (`grep`, `sed -n`, or `node -e` for JSON),
   and check status codes, content types and required fields against
   it.
3. Send one request per recorded command, numbered NN-what-it-does
   from 01, under the receipts folder in a scenario-specific subfolder:
   `curl -sS -i --max-time 30 -X METHOD "$URL/path"`, with
   `-H 'Content-Type: application/json' --data @body.json` or the
   input-enabled command for a body. `-i` keeps the status line and
   headers in the receipt. To check JSON, also save the body with
   `-o name.json` and test it in a following command with `node -e`
   and an exit code, never by reading alone.
4. Secrets are environment variables, given by name. Use them only as
   "$NAME" inside the command (for example
   `-H "Authorization: Bearer $API_TOKEN"`); never echo, print or
   write them to a file. Toad redacts recorded values; do not search
   receipts or the workspace for secrets.
5. Receipts are written outside the sandbox: commands cannot read or
   list them. Keep every receipt of this scenario in its own subfolder,
   named after the scenario, and send only the commands the scenario
   needs.
6. Compare each response with the expected outcome: status code,
   required headers, body fields and values, and for error cases a
   4xx with a useful message, never a 5xx. A failed expectation is
   FAIL. An unreachable API, a missing secret, a missing tool the
   scenario needs (handle it as the cli-test-scenario skill describes,
   installing only when the request allows it) or an ambiguous step is
   ERROR. A 5xx where the scenario expected success is FAIL, with the
   response as evidence.
7. Create only the data the scenario needs, and delete it afterwards
   when the API allows; say in Limits what was left behind.
8. Return a scenario report with the verdict, each request with its
   status and what was checked, and absolute receipt paths, without
   inlining receipt contents. For FAIL, identify the first failing
   request and why.

<!-- forge:generated v1 sha256=83fad25f2c4139f90418b0cc79b5f20d841bd6d0d0300b42d4acd8f71f9e9008 -->
