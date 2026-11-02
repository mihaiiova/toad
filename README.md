# TOaD

A testing agent for the web apps and command-line programs you build. You say what
should work, in plain words; TOaD tests it in a real headless browser or a
sandboxed shell and returns a verdict (PASS, FAIL or ERROR), a report per
scenario, and receipts: screenshots for web steps, and a record of every
command (exit code, output, duration) for CLI steps.

It is built to be called by your coding agent (Claude Code, Pi, Codex, Cursor
or any MCP client): the agent hands TOaD a test, TOaD runs it independently,
and the agent gets back evidence instead of its own opinion of its work.

- [Requirements](#requirements)
- [Install](#install-once-per-machine)
- [Connect your coding agent](#connect-your-coding-agent)
- [Test a project](#test-a-project)
- [See results in the browser](#see-results-in-the-browser)
- [Reference](#reference)
- [Security and limits](#security-and-limits)

## Requirements

| | Needed for |
|---|---|
| Linux or macOS, Node.js 22+ | everything |
| [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) | running the agent |
| A [DeepSeek](https://platform.deepseek.com) API key | the model the agent uses |
| Network access | installing packages and the browser; calling the model |
| [Bubblewrap](https://github.com/containers/bubblewrap) **0.12.0** exactly (`bwrap --version`), Linux only | CLI tests; web tests work without it |

## Install (once per machine)

```sh
git clone https://github.com/mihaiiova/toad.git
cd toad/agent
./run                       # installs the pinned packages; type /login, pick DeepSeek, then exit
npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing
cd ../mcp && npm install
npm link                    # optional: puts `toad` on your PATH
```

`/login` stores the key in `agent/.forge/pi-home`, separate from your own Pi
setup. Instead of logging in, you can export `DEEPSEEK_API_KEY` in the
environment the MCP server starts in.

The commands below write `toad`; without `npm link`, use
`node /path/to/toad/mcp/cli.mjs` instead.

## Connect your coding agent

Register TOaD once; every project uses the same server, and each call says
which project it is for.

**Claude Code**

```sh
claude mcp add --scope user toad -- toad mcp
```

**Pi**

```sh
pi mcp add toad -- toad mcp
```

Tests take minutes. Give the server a long request timeout, for example
`"requestTimeoutMs": 900000` on its entry in `~/.pi/agent/mcp.json`.

**Codex**

```sh
codex mcp add toad -- toad mcp
```

**Any other MCP client** (Cursor, Windsurf, Claude Desktop, …) takes a JSON
entry in its MCP settings:

```json
{
  "mcpServers": {
    "toad": { "command": "node", "args": ["/path/to/toad/mcp/cli.mjs", "mcp"] }
  }
}
```

TOaD sends progress every 15 seconds while it tests, so clients that reset
their timeout on progress wait for long runs. If yours does not, raise its MCP
tool timeout to 15 minutes or more.

Then check it is connected: ask your agent to *"list the TOaD tools"*. You
should see `get_toad_guide`, `setup_project`, `run_project_test`,
`run_web_test` and `run_cli_test`.

The server also gives the agent a guide (the `get_toad_guide` tool and the
`toad://guide` resource) on how to write good tests and handle credentials.
Most clients pick it up from the server's instructions; if yours does not,
tell the agent: *"Call get_toad_guide before using TOaD."*

## Test a project

### 1. Ask your agent

In your project, ask your coding agent in plain words, for example:

> Set up TOaD in this project, then use it to test the sign-up flow on
> http://localhost:3000: a new user can register and lands on the dashboard.

> Use TOaD to test our CLI: `node dist/cli.js --help` lists every command,
> and `init` in an empty folder creates `config.json`.

The agent calls `setup_project` once, writes a handoff (the target, the goal
and scenarios with expected outcomes) and calls `run_project_test`. It gets
back the verdict, the report and the receipt paths.

Before you ask:

- **Web apps:** start the app first. TOaD runs on your machine, so
  `localhost` works. Use a test or staging environment: TOaD clicks, types
  and submits forms.
- **CLIs:** build the program first. TOaD copies the project into a sandbox
  and runs commands there; it never changes your files.

### 2. Save defaults (optional)

Setup creates `.toad/toad.yaml`. Fill it in, and your agent can leave the
target out of every handoff:

```yaml
web:
  url: http://localhost:3000
cli:
  workdir: .                  # relative to the project, or absolute
  program: node dist/cli.js
timeout_minutes: 15
```

It holds no secrets; commit it.

### 3. Add test logins (if needed)

Put test-only values in `.toad/.env` **yourself**, in your editor, one
`NAME=value` per line:

```sh
TOAD_TEST_EMAIL=tester@example.com
TOAD_TEST_PASSWORD=a-test-password
```

Then tell your agent the names, never the values. TOaD passes only the names
a handoff asks for to that run: the browser types them into the page, or CLI
commands read them as `$NAME`. `.toad/.gitignore` keeps `.env` and `runs/`
out of git.

### What setup creates

```
<project>/.toad/
├── toad.yaml        project defaults (commit it)
├── .env             secret values (ignored by git)
├── .env.example     the names, for your team (commit it)
├── .gitignore
└── runs/            one folder per run (ignored by git)
    └── 2026-11-02T15-04-17-657Z-<id>/
        ├── handoff.yaml     what was asked, with defaults filled in
        ├── reports/report.md
        └── receipts/        screenshots, page snapshots, command records
```

## See results in the browser

```sh
toad ui                 # http://127.0.0.1:8787, or the next free port
toad ui --port 9000
```

One page shows the runs of every project TOaD is set up in, newest first,
with a project filter. Open a run to see the scenarios, the report, every
screenshot and every recorded command. It listens on localhost only.

```sh
toad projects                     # the projects in the list
toad projects forget /path/to/x   # drop one from the list (its files stay)
```

A project joins the list when it is set up or runs a test. Projects set up
before the viewer existed have a `.toad/history.mjs` copy; it still works and
can be deleted.

## Reference

### MCP tools

| Tool | What it does |
|---|---|
| `get_toad_guide` | Returns the guide for coding agents |
| `setup_project` | Creates `.toad/` in a project (never overwrites files) and adds it to the viewer's list |
| `run_project_test` | Runs a handoff in a set-up project; results go to `.toad/runs/<id>/` |
| `run_web_test`, `run_cli_test` | Legacy: tests without a project (see [Legacy tools](#legacy-tools)) |

### Handoff

`run_project_test` takes `project_path` (absolute, no symlinks), a `handoff`,
and optionally `timeout_minutes` and `screenshots` (`inline`, the default,
attaches up to 8 images; `paths` returns only file paths):

```json
{
  "version": 1,
  "kind": "web",
  "target": { "url": "http://localhost:3000" },
  "request": {
    "goal": "Check sign-in",
    "scenarios": [
      { "name": "Sign in", "steps": "Open sign-in, enter the test login", "expected": "The dashboard is shown" }
    ]
  },
  "credentials": {
    "email": { "env": "TOAD_TEST_EMAIL" },
    "password": { "env": "TOAD_TEST_PASSWORD" }
  },
  "limitations": ["Use test data only"]
}
```

For `"kind": "cli"`, the target is `{ "workdir": "/abs/path", "program": "node dist/cli.js" }`.
Fields left out of `target`, and the timeout, come from `toad.yaml`; the
handoff wins where both are set. Without scenarios, TOaD derives them from
the goal.

The result has the report as text and as structured content: `verdict`
(`PASS`, `FAIL`, `ERROR`, or `UNKNOWN` when the report has none), `status`
(how the run itself ended: `ok`, `timeout`, `blocked`, `cancelled`, `error`,
`configuration_error`), `runId`, `receipts` (the folder), `files` and
`screenshots`. A run that could not complete is a tool error; a failing test
is not.

### Where things live

TOaD is installed once; everything about a project stays in that project.

| Where | What |
|---|---|
| `<project>/.toad/` | defaults, secret values, runs |
| `~/.config/toad/projects.json` | the projects the viewer shows |
| `~/.cache/toad/scenarios/` | CLI sandbox workspaces, removed after 7 days unused |
| `$XDG_RUNTIME_DIR/toad/` | run slots and per-run secret files (falls back to a private folder in the system temp directory) |

### Settings

Environment variables, set where the MCP server is registered:

| Variable | Default | |
|---|---|---|
| `TOAD_MAX_CONCURRENT_RUNS` | `2` | Runs at once across every TOaD server on the machine; further calls wait |
| `TOAD_COMMAND_TIMEOUT_S` | `120` | Time limit for each CLI command |
| `TOAD_SCENARIO_TTL_DAYS` | `7` | When unused CLI workspaces are removed; `0` keeps them |
| `TOAD_CONFIG_DIR`, `TOAD_CACHE_DIR`, `TOAD_RUNTIME_DIR` | see above | Move TOaD's per-user folders |
| `TOAD_AGENT_DIR` | `../agent` | Use an agent installed elsewhere |

### Use the agent without MCP

```sh
cd agent
./run --workflow test \
  --input 'request=Test https://demo.playwright.dev/todomvc. Add "buy milk", complete it; expected: "0 items left".' \
  --input receipts=data/receipts/manual-1
./run --workflow test \
  --input 'request=Test the command-line program in the working folder /path/to/project. Invoke it as: node dist/bin.js. Run it with --help; expected: exit code 0.' \
  --input receipts=data/receipts/manual-2
```

The last line of output is JSON with `status` and the report in `answer`,
whose first line is `Verdict: PASS`, `FAIL` or `ERROR`. Receipts are in the
receipts folder.

### How it is built

- **`agent/`**: the testing agent, a [Pi Forge](https://github.com/mihaiiova/pi-forge)
  project. A lead plans the request into scenarios and hands each to a
  specialist: a web-tester that drives Chromium through the
  [Playwright MCP](https://github.com/microsoft/playwright-mcp), or a
  cli-tester that runs commands through `agent/tools/toad-exec.mjs`. Its
  design is `agent/.pi/system.yaml`; change it with `/forge` inside
  `agent/run`.
- **`mcp/`**: the MCP server (`server.mjs`), the run viewer (`ui.mjs`) and the
  `toad` command (`cli.mjs`). The server runs the agent's workflow and maps the
  result onto the tool result; it holds no testing logic.
- **`skills/toad-mcp/SKILL.md`**: the guide served to coding agents.

### How CLI tests run

CLI scenarios use Bubblewrap 0.12.0 on Linux. Preparing a scenario copies the
project to a new workspace under `~/.cache/toad/scenarios/<id>`, skipping
symlinks, `.git`, `.forge`, `.toad`, `receipts`, `.env` and `.env.*` (except
`.env.example`), common credential folders and private-key files. This is a
name-based filter, not detection of every secret: remove other credential
files from the project first. Preparation checks that the sandbox starts and
the workspace and home are writable; the network variant also checks a given
HTTP(S) endpoint. Commands in one scenario share the workspace but not
background processes. The original project is not mounted. A failed
preparation is an infrastructure error; nothing ever runs on the host instead.

Commands run through `/bin/sh` inside Bubblewrap, with no input unless
provided, and stop after 120 seconds. Each produces a receipt. Exact secret
values of at least four characters are redacted from recorded text, but
redaction is not comprehensive.

## Security and limits

**TOaD runs with your permissions.** The agent, its tools and the programs it
tests run as your user. Use it on code and sites you trust, with test
accounts and restricted keys.

**The CLI sandbox is not hardened.** Networking is shared, including
localhost and reachable LAN services; there is no seccomp filter or resource
quota. The host `/usr` and some system configuration are mounted read-only.
Copying and workspace checks assume no hostile process of your user is racing
them. Workspaces persist and may contain sensitive data.

**Credentials are best-effort protected, not isolated.**

- Handoffs carry only names (`{ "env": "NAME" }`), never values. The `.env`
  format is `NAME=value`, with optional matching quotes and no shell
  expansion; duplicate, malformed, missing and empty referenced values are
  rejected. Do not give values to the coding agent in chat.
- Each run gets a mode-0600 file, in a mode-0700 folder, with only the values
  its handoff names. Web runs pass it to the browser launcher; CLI runs pass
  the variables to the sandboxed command. A run without credentials gets an
  empty file, never the shared store. Names that affect process startup
  (`PATH`, `LD_*`, `NODE_OPTIONS`, `BASH_ENV`, …) are rejected for CLI runs.
- Pi Forge passes the caller's whole environment to Pi, including provider
  keys; agents, tools, subprocesses and other processes of your user can read
  the run's environment and file. A tested program can send credentials over
  the network or write them into its workspace.
- After the run, TOaD removes the file. If Forge reports incomplete cleanup,
  or the server is killed, the file stays in the runtime folder's `secrets/`
  (`toad-browser-*` or `toad-cli-*`) and the result names it; remove it once
  no process can still be using it.
- Redaction of the report and result is best effort. Screenshots, page
  content, logs, files and transformed values can still expose secrets; treat
  every run folder as sensitive.

**Paths are checked, not confined.** `project_path` must be absolute and
canonical; symlinked projects and `.toad` folders are rejected, and the `.env`
file is opened without following symlinks. These checks assume no hostile
process is changing the project at the same time.

**Web tests act on the site.** The browser clicks, types and submits forms.
Point it at test or staging environments.

### Legacy tools

`run_web_test` and `run_cli_test` predate projects. They take `url`, or
`workdir` and `program`, plus `what`, optional `scenarios`, `secrets`,
`timeout_minutes` and (web) `screenshots`. Their receipts go to
`agent/data/receipts`. Their `secrets` are names in the shared
`agent/.forge/test-secrets.env` (create it with mode 600), and that whole
store is available to the run, not only the names requested. Prefer
`run_project_test`.

## Development

```sh
cd mcp && npm test                           # MCP server, viewer and slots, with a stand-in for the agent
node --test agent/tools/toad-exec.test.mjs   # the CLI sandbox and command recorder
```
