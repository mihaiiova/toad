# TOaD

A testing agent for the web apps and command-line programs you build. You say what
should work, in plain words; TOaD tests it in a real headless browser or a
sandboxed container and returns a verdict (PASS, FAIL or ERROR), a report per
scenario, and receipts: screenshots for web steps, and a record of every
command (exit code, output, duration) for CLI steps.

It is built to be called by your coding agent (Claude Code, Pi, Codex, Cursor
or any MCP client): the agent hands TOaD a test, TOaD runs it independently,
and the agent gets back evidence instead of its own opinion of its work.

```sh
npm install -g @mihaiiova/toad && toad setup
```

- [Requirements](#requirements)
- [Install](#install)
- [Connect your coding agent](#connect-your-coding-agent)
- [Test a project](#test-a-project)
- [See results in the browser](#see-results-in-the-browser)
- [Reference](#reference)
- [Security and limits](#security-and-limits)

## Requirements

| | Needed for |
|---|---|
| Node.js 22.19+ on Linux or macOS | everything (Windows: see below) |
| A [DeepSeek](https://platform.deepseek.com/api_keys) API key | the model the agent uses |
| [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io), running | CLI tests; web tests work without it |

On Linux without Docker or Podman, CLI tests can use
[Bubblewrap](https://github.com/containers/bubblewrap) 0.8 or later instead.

**Windows:** TOaD's code is written to run there, but it is not verified yet,
and the Pi Forge workflow runner it builds on has not been tested on Windows.
Use WSL until a release says otherwise.

## Install

```sh
npm install -g @mihaiiova/toad
toad setup
```

`toad setup` walks through everything once, and can be run again at any time:

1. Prepares the testing agent in `~/.local/share/toad/agent/<version>/`.
2. Downloads Chromium for web tests (about 150 MB the first time).
3. Asks for your DeepSeek key, checks it, and saves it in
   `~/.config/toad/credentials.json`, readable only by you.
4. Finds Docker or Podman for CLI tests and offers to download the default
   image (`node:22-bookworm`, about 1 GB; otherwise it downloads on the first
   CLI test).
5. Finds Claude Code, Codex and Pi on your machine and offers to register
   TOaD with each.

`toad setup --yes` accepts every default without asking; it then takes the key
from `DEEPSEEK_API_KEY`. Check the result any time with:

```sh
toad doctor
```

### Update

```sh
toad update
```

It installs the latest version, prepares its agent (your key and projects
stay), and asks you to restart your coding agents.

## Connect your coding agent

`toad setup` registers TOaD with the coding agents it finds. To do it by hand,
register the command `toad mcp` once; every project uses the same server, and
each call says which project it is for.

| Client | Command |
|---|---|
| Claude Code | `claude mcp add --scope user toad -- toad mcp` |
| Codex | `codex mcp add toad -- toad mcp` |
| Pi | `pi mcp add toad -- toad mcp`, then set `"requestTimeoutMs": 900000` on its entry in `~/.pi/agent/mcp.json` |

**Any other MCP client** (Cursor, Windsurf, Claude Desktop, …) takes a JSON
entry in its MCP settings:

```json
{
  "mcpServers": {
    "toad": { "command": "toad", "args": ["mcp"] }
  }
}
```

TOaD sends progress every 15 seconds while it tests, so clients that reset
their timeout on progress wait for long runs. If yours does not, raise its MCP
tool timeout to 15 minutes or more.

Restart the coding agent, then ask it to *"list the TOaD tools"*. You should
see `get_toad_guide`, `setup_project`, `run_project_test`, `run_web_test` and
`run_cli_test`.

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

- **Web apps:** start the app first. The browser runs on your machine, so
  `localhost` works. Use a test or staging environment: TOaD clicks, types
  and submits forms.
- **CLIs:** TOaD copies the project into a fresh workspace and runs each
  command in a Linux container; it never changes your files. Build the
  program first, or let the scenario build it. Dependencies installed on a Mac
  or Windows machine may not run in Linux (native modules especially); a
  scenario can run `npm ci` itself.

### 2. Save defaults (optional)

Setup creates `.toad/toad.yaml`. Fill it in, and your agent can leave the
target out of every handoff:

```yaml
web:
  url: http://localhost:3000
cli:
  workdir: .                  # relative to the project, or absolute
  program: node dist/cli.js
  image: node:22-bookworm     # the container image CLI commands run in
timeout_minutes: 15
```

It holds no secrets; commit it. Pick an `image` with your CLI's runtime, for
example `python:3.12` or `golang:1.23`.

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

A project joins the list when it is set up or runs a test.

## Reference

### Commands

| Command | |
|---|---|
| `toad setup [--yes] [--no-register] [--skip-browser] [--skip-image] [--force]` | Prepare or repair everything TOaD needs |
| `toad doctor` | Check the agent, model key, browser, CLI sandbox, coding agents and updates |
| `toad update` | Install the latest version and prepare it |
| `toad mcp` | The MCP server; coding agents start it |
| `toad ui [--port <port>]` | The run viewer |
| `toad projects [forget <path>]` | The projects the viewer shows |

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

For `"kind": "cli"`, the target is
`{ "workdir": "/abs/path", "program": "node dist/cli.js", "image": "node:22-bookworm" }`
(`image` optional). Fields left out of `target`, and the timeout, come from
`toad.yaml`; the handoff wins where both are set. Without scenarios, TOaD
derives them from the goal.

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
| `~/.config/toad/` | `projects.json` (the viewer's list), `credentials.json` (the model key) |
| `~/.local/share/toad/agent/<version>/` | the prepared agent; older versions are removed on update |
| `~/.cache/toad/scenarios/` | CLI workspaces, removed after 7 days unused |
| `$XDG_RUNTIME_DIR/toad/` | run slots and per-run secret files (falls back to a private folder in the system temp directory) |

On Windows these are under `%APPDATA%\toad` and `%LOCALAPPDATA%\toad`.

### Settings

Environment variables, set where the MCP server is registered:

| Variable | Default | |
|---|---|---|
| `DEEPSEEK_API_KEY` | the saved key | The model key; overrides the one `toad setup` saved |
| `TOAD_MAX_CONCURRENT_RUNS` | `2` | Runs at once across every TOaD server on the machine; further calls wait |
| `TOAD_CLI_SANDBOX` | `auto` | `container`, `bwrap`, or `auto` (a running container runtime, else Bubblewrap) |
| `TOAD_CONTAINER_RUNTIME` | first that answers | `docker` or `podman` |
| `TOAD_CLI_IMAGE` | `node:22-bookworm` | Image for CLI tests when the project does not set one |
| `TOAD_COMMAND_TIMEOUT_S` | `120` | Time limit for each CLI command |
| `TOAD_SCENARIO_TTL_DAYS` | `7` | When unused CLI workspaces are removed; `0` keeps them |
| `TOAD_CONFIG_DIR`, `TOAD_DATA_DIR`, `TOAD_CACHE_DIR`, `TOAD_RUNTIME_DIR` | see above | Move TOaD's per-user folders |
| `TOAD_AGENT_DIR` | the prepared agent | Use an agent somewhere else |

### How it is built

- **`agent/`**: the testing agent, a [Pi Forge](https://github.com/mihaiiova/pi-forge)
  project. A lead plans the request into scenarios and hands each to a
  specialist: a web-tester that drives Chromium through the
  [Playwright MCP](https://github.com/microsoft/playwright-mcp), or a
  cli-tester that runs commands through `agent/tools/toad-exec.mjs`. Its
  design is `agent/.pi/system.yaml`. The package ships this definition;
  `toad setup` copies it and installs its pinned Pi packages, and runs start
  Forge's workflow runner directly, without a shell script.
- **`mcp/`**: the MCP server (`server.mjs`), the run viewer (`ui.mjs`), setup
  (`setup.mjs`, `agent.mjs`) and the `toad` command (`cli.mjs`). The server
  runs the agent's workflow and maps the result onto the tool result; it holds
  no testing logic.
- **`skills/toad-mcp/SKILL.md`**: the guide served to coding agents.

### How CLI tests run

Preparing a scenario copies the project to a new workspace under
`~/.cache/toad/scenarios/<id>`, skipping symlinks, `.git`, `.forge`, `.toad`,
`receipts`, `.env` and `.env.*` (except `.env.example`), common credential
folders and private-key files. This is a name-based filter, not detection of
every secret: remove other credential files from the project first.
Preparation checks that the sandbox starts and that only the workspace and
its home are writable; the network variant also checks a given HTTP(S)
endpoint. A failed preparation is an infrastructure error; nothing ever runs
on the host instead.

**In a container** (Docker or Podman, any OS), each command is a fresh
`docker run` of the project's image with the workspace mounted at `/work`, a
read-only root filesystem, a private `/tmp`, no Linux capabilities, no
privilege escalation, a process limit, and your user ID on Linux. Commands in
one scenario share the workspace but not processes. The container uses the
runtime's default network: it can reach the internet, and your machine as
`host.docker.internal`, not as `localhost`. Selected credentials reach it
through a private env file that is deleted after the command.

**In Bubblewrap** (Linux), commands run in new user, PID, IPC and UTS
namespaces with the host's `/usr` and some system configuration read-only,
sharing the host network, including `localhost`.

Either way, commands run through `/bin/sh`, with no input unless provided,
stop after 120 seconds, and each produces a receipt. Exact secret values of at
least four characters are redacted from recorded text, but redaction is not
comprehensive.

### Use the agent without MCP

From a git checkout whose agent you have set up with `cd agent && ./run`
(`/login`, then exit):

```sh
cd agent
./run --workflow test \
  --input 'request=Test https://demo.playwright.dev/todomvc. Add "buy milk", complete it; expected: "0 items left".' \
  --input receipts=data/receipts/manual-1
```

The last line of output is JSON with `status` and the report in `answer`,
whose first line is `Verdict: PASS`, `FAIL` or `ERROR`.

## Security and limits

**TOaD runs with your permissions.** The agent, its tools and the browser run
as your user. Use it on code and sites you trust, with test accounts and
restricted keys.

**The CLI sandbox limits damage; it is not a security boundary for hostile
code.** Containers share the host kernel, and both backends allow network
access. Workspaces persist (until pruned) and may contain sensitive data.
Copying and workspace checks assume no hostile process of your user is racing
them.

**Credentials are best-effort protected, not isolated.**

- Handoffs carry only names (`{ "env": "NAME" }`), never values. The `.env`
  format is `NAME=value`, with optional matching quotes and no shell
  expansion; duplicate, malformed, missing and empty referenced values are
  rejected. Do not give values to the coding agent in chat.
- Each run gets a mode-0600 file, in a mode-0700 folder, with only the values
  its handoff names. Web runs pass it to the browser launcher; CLI runs pass
  the variables to the sandboxed command. A run without credentials gets an
  empty file, never the shared store. Names that affect process startup or the
  container runtime (`PATH`, `LD_*`, `NODE_OPTIONS`, `DOCKER_*`, …) are
  rejected for CLI runs.
- The DeepSeek key is passed to the agent's environment. Pi Forge passes that
  whole environment to Pi, its tools and subprocesses, and other processes of
  your user can read it. A tested program can send credentials over the
  network or write them into its workspace.
- After the run, TOaD removes the per-run file. If Forge reports incomplete
  cleanup, or the server is killed, it stays in the runtime folder's
  `secrets/` and the result names it; remove it once no process can still be
  using it.
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
`timeout_minutes` and (web) `screenshots`. Their receipts go to the agent's
`data/receipts`. Their `secrets` are names in the agent's shared
`.forge/test-secrets.env`, and that whole store is available to the run, not
only the names requested. Prefer `run_project_test`.

## Development

```sh
git clone https://github.com/mihaiiova/toad.git && cd toad
npm install
cd agent && ./run          # installs the agent's Pi packages; /login to DeepSeek, then exit
cd .. && npm link          # `toad` now runs this checkout
npm test                   # MCP server, viewer, slots, launcher, and the CLI sandbox on every backend present
```

A checkout whose `agent/` has been set up this way is used in place of the
prepared copy. Change the agent with `/forge` inside `agent/run`.

### Releasing

`.github/workflows/test.yml` runs the tests on Linux, macOS and Windows for
every push. To publish a version to npm:

```sh
npm version minor          # or patch / major: updates package.json and tags
git push --follow-tags     # the release workflow tests and publishes the tag
```

Publishing needs an npm automation token in the repository secret `NPM_TOKEN`.
