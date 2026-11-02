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
- **`mcp/`**: an MCP server with project setup and handoff tools, plus the
  legacy `run_web_test` and `run_cli_test` tools. It runs the bot's workflow
  and maps the result onto the tool result.

### How CLI tests run

CLI scenarios use Bubblewrap 0.12.0 on Linux. The `prepare-scenario` tool
copies the requested project to a unique retained workspace under
`agent/.forge/scenarios/<id>`, skipping all symlinks, `.git`, `.forge`,
`.revisor`, `receipts`, `.env` and `.env.*` (except `.env.example`), common
credential directories and private-key extensions. This is a name-based
filter, not detection of every possible secret: users must remove other
credential files from the project before preparing a scenario. It checks
sandbox startup and writable workspace/home; the network preparation variant
also checks an explicitly supplied HTTP(S) endpoint. The preparation returns
an ID used by every `run-command` call in that scenario. Multiple commands
share the copied workspace, but not background processes. The original
project is not mounted. Failed preparation and sandbox startup are
infrastructure errors; there is no host-execution fallback.

Commands run through `/bin/sh` inside Bubblewrap. They have no input unless
provided, are stopped after 120 seconds (`REVISOR_COMMAND_TIMEOUT_S`), and
produce recorded receipts. The legacy shared `.forge/test-secrets.env` is
passed to CLI commands; reserved environment names that could affect the
host launcher are rejected. Exact secret values of at least four characters
are redacted from recorded text, but redaction is not comprehensive.

This is not a hardened sandbox for hostile workloads: networking is shared,
including localhost and reachable LAN services, and there is no seccomp
filter or resource quota. The host `/usr` and selected system configuration
are mounted read-only. Copying and workspace validation assume no hostile
same-user process racing filesystem operations. Workspaces persist and may
contain sensitive data; remove them manually when no longer needed.

## Setup (once, Linux or macOS)

Requires Pi, Node.js 22+, Bubblewrap 0.12.0 on Linux for CLI tests, and network access.

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
their values are redacted from some text output. This is not a guarantee that
the model or a malicious page cannot obtain them; arbitrary output, screenshots,
and transformations may expose them. The whole shared store is available to the
legacy browser and CLI integration, not just names listed in a request.

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

### Instructions for coding agents

The server exposes `skills/revisor-mcp/SKILL.md` through the read-only
`get_revisor_guide` tool and the `revisor://guide` MCP resource. Server
initialization and the project-run tool description direct agents to read the
guide before testing. MCP clients vary in whether they surface server
instructions and resources; if needed, explicitly ask your agent: “Call
`get_revisor_guide` before using Revisor.” The MCP server does not install a
native skill into the client's own skill directory.

### Project-local handoffs

Call `setup_project` with an absolute `project_path` before using
`run_project_test`. Setup creates `.revisor/.env`, `.env.example`, `.gitignore`,
`runs/`, and `history.mjs` without overwriting existing files. If an existing
`.gitignore` does not explicitly ignore `.env` and `runs/`, setup asks you to
add those rules. The run tool takes the same `project_path` and a structured `handoff`:

```json
{
  "version": 1,
  "kind": "web",
  "target": { "url": "http://localhost:3000" },
  "request": { "goal": "Check sign-in", "scenarios": [
    { "name": "Sign in", "steps": "Open sign-in", "expected": "Form is visible" }
  ] },
  "credentials": {
    "email": { "env": "REVISOR_TEST_EMAIL" },
    "password": { "env": "REVISOR_TEST_PASSWORD" }
  },
  "limitations": ["Use test data only"]
}
```

For `kind: "cli"`, use `target.workdir` and `target.program`. Each run stores
`handoff.yaml` (JSON, which is valid YAML 1.2), `receipts/`, and
`reports/report.md` under `.revisor/runs/<timestamp-and-id>/`. Treat all run
artifacts as sensitive; screenshots and output can contain private data.

Browse all past runs in a browser (localhost only):

```sh
node .revisor/history.mjs   # http://127.0.0.1:8787 (set REVISOR_VIEW_PORT to change)
```

Set values locally by editing `.revisor/.env` yourself, for example by using
an editor; do not give values to the coding agent in chat. The supported format
is one `NAME=value` per line, with optional matching single or double quotes;
there is no shell evaluation or expansion. Duplicate names, malformed entries,
missing and empty referenced values are rejected. Credential fields accept
references only, never literal values.

For web runs, the wrapper resolves only the referenced names and writes them
to a mode-0600 per-run temporary dotenv file in a mode-0700 directory. The
Playwright launcher receives the file path through the inherited environment;
credential values are not passed as workflow inputs. Runs without credentials
get an empty per-run file rather than falling back to the shared store. Forge
v0.25.0's trusted-run model applies: Pi, agents, tools and subprocesses can
access the inherited environment and file, and other same-user processes may
also access them. This is not per-tool isolation. Use trusted workloads and
restricted test accounts.

After Forge reports completion and cleanup, the wrapper removes the temporary
file. If Forge reports incomplete cleanup or produces no result, it retains the
file and reports its directory; inspect and remove it only after confirming
all processes have stopped. Abrupt wrapper termination can also leave a file
in the system temporary directory (`revisor-browser-*` or `revisor-cli-*`). Forge's cleanup
report is not proof against all detached or same-user processes.

Project CLI handoffs use the same credential references. The wrapper creates a
per-run private file containing only selected values, and the recorder passes
those variables to the sandboxed command. An empty selection never falls back
to the shared store. Environment names that affect process startup, such as
`PATH`, `LD_*`, `NODE_OPTIONS`, and `BASH_ENV`, are rejected. The program can
transmit credentials over the shared network or write them into the retained
workspace; use trusted code and a restricted test key.

The legacy tools below continue to use the shared agent store. The agent currently writes
its original receipts under `agent/data/receipts`; project-local receipts are
copies, not the only evidence on disk. Cancelled or abruptly terminated calls
may not produce a consolidated report.

An explicit canonical project path is authorization by the MCP caller, not an
OS sandbox. The wrapper rejects symlinked project paths and .revisor directories
and opens the credential file without following symlinks. It assumes the project
and its parent directories are not concurrently modified by a hostile process
running as the same user; path checks are not race-proof filesystem confinement.
Agents and tools retain the filesystem and network permissions of that user.
Screenshots, page content, and arbitrary tool output can expose sensitive data,
even where text redaction is used.

### Trusted-run integration

`agent/tools/playwright-mcp.sh` selects `REVISOR_PLAYWRIGHT_SECRETS_FILE` when
provided and otherwise uses the legacy shared file. Forge passes the caller's
entire environment to Pi, including provider credentials. Do not run untrusted
agents or point the browser at untrusted sites with sensitive credentials.
Exact-value redaction of the wrapper's result and report is best effort, not a
security boundary; screenshots, page content, logs, files, and transformed
values may still expose secrets.

### Legacy tools

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
