# Revisor

A testing bot for web applications. Give it a URL, what to test and,
optionally, scenarios with expected outcomes. It tests them in a real
headless browser and returns a verdict (PASS, FAIL or ERROR), a report per
scenario, and screenshots as receipts.

Two parts, kept separate:

- **`agent/`**: the bot itself, a [Pi Forge](https://github.com/mihaiiova/pi-forge)
  project. A lead plans the request into scenarios and hands each to a
  web-tester specialist that drives Chromium through the
  [Playwright MCP](https://github.com/microsoft/playwright-mcp). Its design
  is `agent/.pi/system.yaml`; change it with `/forge` inside `agent/./run`.
- **`mcp/`**: a thin MCP server with one tool, `run_web_test`. It runs the
  bot's workflow and maps the result onto the tool result. It holds no
  testing logic.

## Setup (once, Linux or macOS)

Requires Pi, Node.js 22+, and network access.

```sh
cd agent
./run                      # installs the pinned packages; then /login (DeepSeek), and exit
npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing
mkdir -p .forge && touch .forge/test-secrets.env && chmod 600 .forge/test-secrets.env
cd ../mcp && npm install
```

**Login secrets** for sites under test go in `agent/.forge/test-secrets.env`
(gitignored) as `NAME=value`. Callers pass only the names; the browser fills
in the values and the model never sees them. Keep this file separate from
`.env`, so a site under test can't steer the bot into typing other keys.

## Use it directly

```sh
cd agent
./run --workflow test \
  --input 'request=Test https://demo.playwright.dev/todomvc. Add "buy milk", complete it; expected: "0 items left".' \
  --input receipts=data/receipts/manual-1
```

The last line of output is JSON with `status` and the report in `answer`;
the report starts with `## Verdict` and one of PASS, FAIL or ERROR.
Screenshots are in the receipts folder. `status` is about the run itself
(`ok`, `timeout`, `blocked`, `cancelled`, `error`, `configuration_error`), not
the verdict.

## Use it over MCP

Register the server with any MCP client, for example:

```sh
pi mcp add revisor -- node /path/to/revisor/mcp/server.mjs
claude mcp add revisor -- node /path/to/revisor/mcp/server.mjs
```

`run_web_test` takes:

| Argument | |
|---|---|
| `url` | where the application is reachable |
| `what` | what to test: a goal, feature or user flow |
| `scenarios` | optional `[{ name, steps, expected }]` for precise checks |
| `secrets` | optional names from `agent/.forge/test-secrets.env` |
| `timeout_minutes` | optional, default 15 |
| `screenshots` | `inline` (default, up to 8 attached as images) or `paths` |

It returns the report as text, the screenshots, and structured content:
`verdict`, `status`, `runId`, `receipts` (folder) and `screenshots` (absolute
paths). A run that couldn't complete is a tool error; a failing test is not.
Calls run in parallel, each with its own receipts folder. The server sends
progress every 15 seconds, so clients that reset their timeout on progress
won't give up on long tests; cancelling a call stops the test.

**Safety:** the bot clicks, types and submits forms on the site it is given.
Point it at test or staging environments.

## Tests

```sh
cd mcp && npm test        # the MCP layer, with a stand-in for the bot
```
