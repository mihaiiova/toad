# Paid-baseline defects: offline diagnosis and repair

The [original baseline](evaluation-baseline-2026-11-09.md) remains **incomplete and leaking**, with its measured outcomes/accuracy unchanged. Original private evidence under `.pi/artifacts/evaluations/baseline-20261109T183352Z` was not edited. This investigation used no model requests, paid rerun, setup or downloads. It does not establish repaired real-model accuracy.

## Feedback loops before fixes

Both minimized scout loops were rerun before product edits:

- `node /tmp/toad-native-command-probe.mjs red`: exit 1, two invalid lowercase-placeholder diagnostics, zero registered tools, assertion `required CLI/API command tools absent: no execution receipt can be produced`.
- `node /tmp/toad-web-secret-repro.mjs`: exit 1; authorized alias fill correct, registered credential absent from outputs, **unregistered prefilled value present** in native `browser_find` and four textual output files. Only paths/booleans were reported.

Those temporary harnesses are local investigation aids, not repository dependencies. Durable regression commands are below. Ranked hypotheses were provided before the scouts' probes:

1. CLI/API: config validation suppresses all registration; fixing only placeholder spelling should restore tools. Confirmed with the actual pinned loader/extension, then an actual no-model Pi session.
2. CLI/API: child detection filters otherwise valid tools; setting child mode alone should restore them. Rejected as sufficient: explicit child mode still registered nothing with the old config.
3. CLI/API: child allowlist/lifecycle or model selection loses otherwise available tools. Cannot be the sole cause because registration already failed; later real-model behavior remains untested.
4. Web: expanded alias is echoed. Registered-secret control contradicted this: actual native fill worked without exposing the registered value.
5. Web: native snapshot/find exposes a prefilled unknown password, and relay/session persistence propagates it. Confirmed; registering that value alone made the native control green. Report-only invention was rejected by earlier native YAML/tool-result ingress.

## CLI/API root cause and minimum fix

Pinned `pi-commands@v0.1.0` accepts only lowercase/snake-case placeholder names. Two `{scenarioName}` arguments in the shipped command config made its fail-closed validator reject **the entire config**, including unrelated prepare/structured tools. This is before execution/sandbox/receipt creation.

All 14 failed API/CLI baseline transcript sets contain no command-tool call. Tester-run receipt directories are empty; receipts in other sibling runs are not their evidence. The source config/pin match the evaluated revision, but historical loader stderr was not captured: this is a proven current offline blocker that strongly explains those historical failures, not proof that every downstream real-model problem is solved.

Change only those placeholders to `{scenario_name}` in source declarations and native config, and align the two tester usage descriptions. CLI flag `--scenario-name`, JSON request field `scenarioName`, scenario identities, permissions and dependency pins are unchanged. No blanket Faur regeneration.

New `native-command-registration.test.mjs` exercises:

- Actual installed pinned loader and extension `session_start`, tester allowlist completeness, lead non-exposure, parameter schema and argv expansion, source/native argument alignment.
- Actual native Pi SDK session initialization and post-start active tools under both tester allowlists, with empty temporary settings/auth storage, no prompt/model call or package setup.
- Actual registered `execute` callbacks through fixed command expansion, subprocesses, Bubblewrap preparation, command-with-input, structured CLI and loopback HTTP API execution. Real receipts/typed evidence, scenario binding, recording candidates, machine PASS/FAIL and FAIL-over-receipt-error precedence are retained. No fake-Pi receipts.

## Web root cause, approved contract correction and limits

Fixture version 1 deliberately omitted web credentials from the selected-secret handoff even though it supplied a prefilled synthetic password. Native Playwright MCP 0.0.84 snapshots/find can read that unknown value. Two native YAML snapshots contained it before session copying; `browser_find` tool-result text then entered the saved session and copied tester transcript. This was **fixture-origin unknown-value exposure**, not demonstrated failure of already selected-credential redaction.

The approved narrow correction selects the synthetic web credential through the same existing handoff/secret-resolution/native `--secrets` contract as supplied credentials elsewhere. **Fixture version is now 2**; manifests already record version and source digest, and a regression checks version provenance. Expected PASS-with-no-output-leak, invoice assertions, case identities and the bounded no-follow scanner remain unchanged. Version 1 and 2 are not directly identical benchmarks. The historical leak still counts as a leak; no historical accuracy is recalculated.

No redundant relay sanitizer or new universal privacy mechanism was added: actual native registered-secret response/artifact redaction already passes. `native-web-secrets.test.mjs` uses an explicitly installed pinned native CLI and Chromium, actual relay/scenario binding and the unchanged artifact scanner. It verifies known prefilled-secret protection in native find/snapshot outputs, persisted relayed responses and saved YAML, authorized alias filling with the actual DOM value verified by the page, ordinary invoice-total visibility, native errors and durable operation receipts without invented scenario assertions. Private temporary outputs and secret files are cleaned up.

An **unselected-value negative control still exposes the synthetic value**, and the regression explicitly preserves that finding. Unknown page-origin credentials are not automatically discovered/masked. Screenshot/binary pixel contents, OCR, arbitrary encodings, unknown tokens, arbitrary downloads and other native output paths are not universally protected by these tests. Raw/URL/base64 scanning is bounded byte scanning, not visual inspection. Do not treat a clean byte scan as a comprehensive privacy guarantee.

## Why earlier tests missed this

Direct CLI/API runner tests began after the missing native registration boundary. Fake-Pi server/evaluation tests emitted controlled evidence without loading the pinned extension. Playwright launcher tests checked flags/path wiring, and fake browser tests did not reproduce native aria snapshot/find behavior. They were valid local contracts, not proofs of native integration or real-model quality. The new installed-only integration seams cover these specific missing boundaries, not model reasoning quality.

## Reproduce offline

Requires the already installed `agent/.pi/git/github.com/mihaiiova/pi-commands` v0.1.0, native `@playwright/mcp` 0.0.84 CLI, Chromium and working Bubblewrap. No automatic installation or sandbox downgrade. Missing native prerequisites are explicit skips; supplying nonexistent/wrong-version native paths is an error. Set the two paths to local installed files:

```sh
export TOAD_TEST_PLAYWRIGHT_MCP_CLI=/absolute/installed/@playwright/mcp/cli.js
export TOAD_TEST_CHROMIUM_EXECUTABLE=/absolute/installed/chromium/chrome
export npm_config_offline=true
node --test mcp/test/native-command-registration.test.mjs mcp/test/native-web-secrets.test.mjs mcp/test/evaluation-fixtures.test.mjs mcp/test/evaluation.test.mjs
npm test
npm pack --dry-run --json
```

Observed regression red before source fixes: **28 tests, 23 pass, 5 fail, 0 skipped**. Failures were undefined web credential declaration, invalid native config, empty real Pi active tool set, missing registered execution path and unsafe selected-fixture `browser_find` response. The first harness draft also had an incorrect operation-count expectation; it was corrected to the five actual native calls before recording this red result.

After fixes and expanded API/provenance checks: **37/37 narrow tests pass, 0 skipped**. Full offline `npm test`: **282/282 pass, 0 skipped**, including installed native browser coverage. Original command loop now registers all eight tools; registered-prefill web control is green; original unknown-prefill web loop remains red as documented. Package/native alignment checks pass; `npm pack --dry-run --json` includes 58 files with the required native declarations and excludes private baseline artifacts, secret stores and installed package trees. The final exact-count web check also requires one durable record per caller operation.

No paid rerun is authorized or performed. Review these offline repairs and limits before any separately authorized real-tester evaluation; do not replace the original baseline result with these test counts.
