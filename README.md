# Revisor

A testing bot for web applications and command-line programs. Give it a URL
(web) or a working folder and how to invoke the program (CLI), what to test
and, optionally, scenarios with expected outcomes. It tests web apps in a real
headless browser and CLIs in a shell, and returns a verdict (PASS, FAIL or
ERROR), a report per scenario, and receipts: screenshots for web steps, and a
record of every command (exit code, output, duration) for CLI steps.

Two parts, kept separate:

- **`agent/`**: the bot itself, a [Pi Forge](https://github.com/mihaiiova/pi-forge)
  project. A lead plans the request into scenarios and hands each to a
  specialist: a web-tester that drives Chromium through the
  [Playwright MCP](https://github.com/microsoft/playwright-mcp), or a
  cli-tester that runs commands through `agent/tools/revisor-exec.mjs`. Its
  design is `agent/.pi/system.yaml`; change it with `/forge` inside
  `agent/./run`.
- **`mcp/`**: a thin MCP server with two tools, `run_web_test` and
  `run_cli_test`. It runs the bot's workflow and maps the result onto the
  tool result. It holds no testing logic.

### How CLI tests run

The cli-tester has no shell of its own. It runs every command through one
recorder (`agent/tools/revisor-exec.mjs`, declared to Forge as
`run-command` and `run-command-with-input`), which:

- runs the command with `/bin/sh` in the working folder the request names;
- gives it no input (or the input the scenario provides), and stops it after
  120 s (`REVISOR_COMMAND_TIMEOUT_S`), with everything it started;
- puts the login secrets from `.forge/test-secrets.env` in its environment
  and redacts their values from everything recorded or shown;
- writes a receipt per command into the run's receipts folder.

Commands run with your user's permissions; there is no sandbox. The tester
is told to write only inside the receipts folder unless a scenario says to
change the project. Run Revisor in a container if that isn't enough.

## Setup (once, Linux or macOS)

Requires Pi, Node.js 22+, and network access.

```sh
cd agent
./run                      # installs the pinned packages; then /login (DeepSeek), and exit
npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing
mkdir -p .forge && touch .forge/test-secrets.env && chmod 600 .forge/test-secrets.env
cd ../mcp && npm install
```

**Login secrets** for what's under test go in `agent/.forge/test-secrets.env`
(gitignored) as `NAME=value`. Callers pass only the names. In web tests the
browser fills in the values; in CLI tests commands use them as `$NAME`, and
their values are redacted from the output. The model never sees them. Keep this file separate from
`.env`, so a site under test can't steer the bot into typing other keys.

## Use it directly

```sh
cd agent
./run --workflow test \
  --input 'request=Test https://demo.playwright.dev/todomvc. Add "buy milk", complete it; expected: "0 items left".' \
  --input receipts=data/receipts/manual-1
./run --workflow test \
  --input 'request=Test the command-line program in the working folder /path/to/project. Invoke it as: node dist/bin.js. Run it with --help; expected: exit code 0.' \
  --input receipts=data/receipts/manual-2
```

The last line of output is JSON with `status` and the report in `answer`;
the report's first line is `Verdict: PASS`, `FAIL` or `ERROR`.
Receipts are in the receipts folder. `status` is about the run itself
(`ok`, `timeout`, `blocked`, `cancelled`, `error`, `configuration_error`), not
the verdict.

## Use it over MCP

Register the server with any MCP client, for example:

```sh
pi mcp add revisor -- node /path/to/revisor/mcp/server.mjs
claude mcp add revisor -- node /path/to/revisor/mcp/server.mjs
```

| Argument | `run_web_test` | `run_cli_test` |
|---|---|---|
| `url` | where the application is reachable | |
| `workdir` | | absolute path of the folder to run the program in |
| `program` | | how to invoke it there, e.g. `node dist/bin.js` or `owlie` |
| `what` | what to test | what to test |
| `scenarios` | optional `[{ name, steps, expected }]` | same |
| `secrets` | optional names from `agent/.forge/test-secrets.env` | same |
| `timeout_minutes` | optional, default 15 | same |
| `screenshots` | `inline` (default, up to 8 attached as images) or `paths` | |

Both return the report as text and structured content: `verdict`, `status`,
`runId`, `receipts` (the run's folder, absolute), `files` (every receipt) and
`screenshots`. `run_web_test` also attaches screenshots as images. A run that
couldn't complete is a tool error; a failing test is not.
Calls run in parallel, each with its own receipts folder. The server sends
progress every 15 seconds, so clients that reset their timeout on progress
won't give up on long tests; cancelling a call stops the test.

**Safety:** the bot clicks, types and submits forms on the site it is given.
Point it at test or staging environments.

## Tests

```sh
cd mcp && npm test                              # the MCP layer, with a stand-in for the bot
node --test agent/tools/revisor-exec.test.mjs   # the command recorder
```
