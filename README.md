# Toad

A testing agent for the web apps, command-line programs and HTTP APIs you build.
You say what should work, in plain words; Toad tests it in a real headless
browser or a sandboxed container and returns a verdict (PASS, FAIL or ERROR), a
report per scenario, and receipts: screenshots for web steps, and a record of
every command or request (exit code, output, duration) for CLI and API steps.

It is built to be called by your coding agent (Claude Code, Pi, Codex, Cursor
or any MCP client): the agent hands Toad a test, Toad runs it independently,
and the agent gets back evidence instead of its own opinion of its work.
Tests worth keeping are saved as suites in the project, and `toad run` runs
them again without a coding agent: before a release, or in CI on every
deploy.

```sh
npm install -g github:mihaiiova/toad && toad setup
```

- [Requirements](#requirements)
- [Install](#install)
- [Connect your coding agent](#connect-your-coding-agent)
- [Test a project](#test-a-project)
- [See results in the browser](#see-results-in-the-browser)
- [Run tests on every deploy](#run-tests-on-every-deploy)
- [Reference](#reference)
- [Security and limits](#security-and-limits)

## Requirements

| | Needed for |
|---|---|
| Node.js 22.19+ on Linux or macOS | everything (Windows: see below) |
| An API key for a model provider Pi supports (Anthropic, OpenAI, Google, DeepSeek, OpenRouter and [many more](https://pi.dev/models)) | the model the agent uses |
| [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io), running | CLI and API tests; web tests work without it (on a CI runner without either, see `--sandbox none`) |

On Linux without Docker or Podman, CLI tests can use
[Bubblewrap](https://github.com/containers/bubblewrap) 0.8 or later instead.

**Windows:** Toad's code is written to run there, but it is not verified yet:
stopping a cancelled or timed-out run relies on POSIX process groups, which
Windows does not have, so testers started in the background can keep running.
Use WSL until a release says otherwise.

## Install

```sh
npm install -g github:mihaiiova/toad
toad setup
```

Toad installs straight from GitHub for now (it is not on npm yet). Add a
release tag, such as `#v0.7.0`, or `#<commit>` to install that version
instead of `main`.

`toad setup` walks through everything once, and can be run again at any time:

1. Prepares the testing agent in `~/.local/share/toad/agent/<version>/`.
2. Downloads Chromium for web tests (about 150 MB the first time).
3. Asks which models to use: a lead model, which plans each test and writes
   the report, and a tester model, which runs the scenarios (see
   [Choosing models](#choosing-models)). For each, pick a provider, then one
   of its suggested models or any other model Pi can run. It asks for each
   provider's key, checks every model with one short call (a few dozen
   tokens), and saves the keys in `~/.config/toad/credentials.json` and the
   choice in `~/.config/toad/settings.json`, both readable only by you.
4. Finds Docker or Podman for CLI tests and offers to download the default
   image (`node:22-bookworm`, about 1 GB; otherwise it downloads on the first
   CLI test).
5. Finds Claude Code, Codex and Pi on your machine and offers to register
   Toad with each.

`toad setup --yes` accepts every default without asking: it keeps the current
models (DeepSeek's `deepseek-flash` for both on a new install) and takes each
key from the provider's variable, such as `DEEPSEEK_API_KEY`. Choose models
without the questions with `--lead-model` and `--tester-model`, or `--model`
for both, for example:

```sh
ANTHROPIC_API_KEY=… toad setup --yes --lead-model anthropic/claude-opus-5-5 --tester-model anthropic/claude-haiku-5-5
```

Check the result any time with:

```sh
toad doctor
```

### Choosing models

Toad runs on two models, which can come from different providers:

| | Does | Choose |
|---|---|---|
| Lead | plans the scenarios and writes the report, a few calls per test | a strong model |
| Tester | runs each scenario in a browser or shell, in long tool loops, often several at once | a fast, cheaper model; most of the cost is here |

Toad keeps no list of models. When setup runs, it reads two public catalogs:
[Pi's](https://pi.dev/models), for the models Pi can run, and
[models.dev](https://models.dev), for release dates, prices and tool support.
It takes the newest model of each family from the provider's current
generation, offers the pricier ones for the lead and the cheaper ones for the
testers, so a model released after your version of Toad is offered without
updating Toad. Any other model the provider offers is a search away. Without
models.dev there are no suggestions, only the search. Without pi.dev, the
search covers the models bundled with Pi.

The testers rely on tool calls over long browser and shell sessions, so a
weak tester model gives wrong verdicts more often. Run `toad setup` again to
change models; your projects and runs stay.

### Update

```sh
toad update
```

It installs the latest `main` from GitHub, prepares its agent (your models, keys and
projects stay), and asks you to restart your coding agents.

## Connect your coding agent

`toad setup` registers Toad with the coding agents it finds. To do it by hand,
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

Toad sends progress every 15 seconds while it tests, so clients that reset
their timeout on progress wait for long runs. If yours does not, raise its MCP
tool timeout to 15 minutes or more.

Restart the coding agent, then ask it to *"list the Toad tools"*. You should
see `get_toad_guide`, `setup_project`, `run_project_test`, `run_web_test` and
`run_cli_test`.

The server also gives the agent a guide (the `get_toad_guide` tool and the
`toad://guide` resource) on how to write good tests and handle credentials.
Most clients pick it up from the server's instructions; if yours does not,
tell the agent: *"Call get_toad_guide before using Toad."*

## Test a project

### 1. Ask your agent

In your project, ask your coding agent in plain words, for example:

> Set up Toad in this project, then use it to test the sign-up flow on
> http://localhost:3000: a new user can register and lands on the dashboard.

> Use Toad to test our CLI: `node dist/cli.js --help` lists every command,
> and `init` in an empty folder creates `config.json`.

> Use Toad to test the orders API on http://localhost:8080/api against
> `openapi.yaml`: creating an order returns 201 with its ID, and a request
> without a token gets 401, never a 500.

The agent calls `setup_project` once, writes a handoff (the target, the goal
and scenarios with expected outcomes) and calls `run_project_test`. It gets
back the verdict, each scenario's result, the report and the receipt paths.

To keep a test, ask for a suite: *"Save that as a Toad suite tagged smoke."*
The agent writes `.toad/suites/<name>.yaml`, which you commit and run with
`toad run` (see [Run tests on every deploy](#run-tests-on-every-deploy)).

Before you ask:

- **Web apps:** start the app first. The browser runs on your machine, so
  `localhost` works. Use a test or staging environment: Toad clicks, types
  and submits forms.
- **CLIs:** Toad copies the project into a fresh workspace and runs each
  command in a Linux container; it never changes your files. Build the
  program first, or let the scenario build it. Dependencies installed on a Mac
  or Windows machine may not run in Linux (native modules especially); a
  scenario can run `npm ci` itself.
- **APIs:** start the API first. Requests run in the same sandbox as CLI
  commands, and each one is recorded with its status, headers and body. In a
  container, Toad tells the tester to use `host.docker.internal` for a
  `localhost` URL, so the API must listen on `0.0.0.0`, not only
  `127.0.0.1`. Name your OpenAPI description, if you have one, and Toad checks
  responses against it. Use a test environment: scenarios may create, change
  and delete data.

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
  path:                       # prepend workspace-relative tool directories to PATH
    - node_modules/.bin
  setup:                      # run once in the sandbox before any scenario
    - npm ci --ignore-scripts
api:
  url: http://localhost:8080/api
  spec: openapi.yaml          # relative to workdir, which defaults to the project
models:                       # optional: this project's models, over `toad setup`'s
  lead: anthropic/claude-sonnet-5-5
  tester: anthropic/claude-haiku-5-5
timeout_minutes: 15
```

It holds no secrets; commit it. Pick an `image` with your CLI's runtime, for
example `python:3.12` or `golang:1.23`.

`setup` (for `cli` and `api`) lists commands Toad itself runs once, in the
sandbox, before any scenario: installing dependencies, or a tool the tests
need that is not in `package.json`. Every scenario then starts from a copy of
the result, and each command is recorded under `receipts/setup/`. If one
fails, the run ends as `ERROR` with `status: setup_failed` and no scenario
runs. The sandbox's root is read-only, so install locally rather than
globally:

```yaml
cli:
  setup:
    - npm ci --ignore-scripts
    - npm install --no-save @earendil-works/pi-coding-agent@1.5.0  # its bin is node_modules/.bin
```

**Shell and receipt boundaries:** Setup and scenario commands each run in a
fresh shell. Files installed in the workspace persist, but `export PATH=...`
(or `cd`) in one command does not carry over to the next. Invoke local tools
explicitly, for example `./node_modules/.bin/pi --version`, or set PATH in
*each* command that needs it: `PATH="$PWD/node_modules/.bin:$PATH" pi --version`.
Alternatively, set `cli.path: [node_modules/.bin]` (or `api.path`) in
`.toad/toad.yaml`, or `target.path` in a handoff or suite. Toad prepends those
workspace-relative directories to PATH for every setup and scenario command,
in the order given. Handoff values replace project defaults; an empty list
clears them. Absolute paths, `.` and `..` segments, and PATH separators are
not allowed. This changes command lookup: configure only trusted directories.

Receipt paths returned by Toad are host paths for the coding agent or person
reading the results; they are not mounted into the container. Container
commands should use files in their workspace for intermediate data, not try to
read a host receipt path. Toad writes command receipts separately.

By default a tester that finds a program, package or module missing reports
it as a missing prerequisite (`ERROR`). A handoff with `"allow_installs": true`
lets the tester install it inside the sandbox, record the install, and retry.

### 3. Add test logins (if needed)

Put test-only values in `.toad/.env` **yourself**, in your editor, one
`NAME=value` per line:

```sh
TOAD_TEST_EMAIL=tester@example.com
TOAD_TEST_PASSWORD=a-test-password
```

Then tell your agent the names, never the values. Toad passes only the names
a handoff asks for to that run: the browser types them into the page, or CLI
commands and API requests read them as `$NAME` (for example an
`Authorization: Bearer $API_TOKEN` header). `.toad/.gitignore` keeps `.env` and `runs/`
out of git.

### What setup creates

```
<project>/.toad/
├── toad.yaml        project defaults (commit it)
├── .env             secret values (ignored by git)
├── .env.example     the names, for your team (commit it)
├── .gitignore
├── suites/          saved suites for `toad run` (commit them)
│   └── example.yaml     a commented template
└── runs/            one folder per run (ignored by git)
    └── 2026-11-02T15-04-17-657Z-<id>/
        ├── handoff.yaml     what was asked, with defaults filled in
        ├── state.json       progress, verdict, each scenario's result, cost
        ├── reports/report.md
        ├── receipts/        screenshots, page snapshots, command records
        └── sessions/        the lead's and testers' Pi sessions (transcripts)
```

## See results in the browser

```sh
toad ui                 # http://127.0.0.1:8787, or the next free port
toad ui --port 9000
```

One page shows the runs of every project Toad is set up in, newest first,
with a project filter. Open a run to see the scenarios, the report, every
screenshot and every recorded command. It listens on localhost only.

```sh
toad projects                     # the projects in the list
toad projects forget /path/to/x   # drop one from the list (its files stay)
```

A project joins the list when it is set up or runs a test.

## Run tests on every deploy

A handoff your agent sends once can be saved as a **suite** and run again
with `toad run`, without a coding agent: on your machine, or in CI after
every deploy.

### Run-local recordings

A passing CLI scenario can leave a **recording**: the exact program and
arguments Toad ran, and the exit-code and stdout assertion that made it pass.
The run viewer shows it beside the scenario's plain-language steps. Capture
never changes the verdict and adds no model calls. API scenarios can also
record a single structured HTTP request with status and body assertions.
Web scenarios show **Not captured**. The format defines a **Not
recordable** status with `unsupported`, `incomplete` or `unsafe` for producers,
but no producer emits it yet, so it does not appear today.

A CLI scenario is recorded only when all of these hold:

- the handoff selects no `credentials`, and sets neither `allow_installs` nor
  `target.setup` or `target.path`;
- the tester covers it with a single structured command, made through
  `cli_run_structured_command`: a program with explicit arguments, an expected
  exit code, and an expected stdout (`equals` or `contains`);
- the tester marks that command complete for the scenario, attesting that this
  one action and assertion cover every step and expected outcome;
- the scenario PASSes in a run that finished successfully, and that command is
  the scenario's only receipt.

**What a recording trusts.** The attestation is the tester's word, not a
mechanical proof, and Toad cannot recognize arbitrary secret values. Program
names, arguments and expected stdout are therefore trusted, non-secret test
data. Do not put a credential, token or other secret in a structured command,
its arguments or its expected output: a recording stores them as written. This
is not a security boundary; treat recordings and their receipts as sensitive.

Production replay is not implemented yet: `toad run` still uses the agent, and saving
recordings with suites is not available. The format, identity and safety rules
below are shared with the producers that will follow.

The shared run-local status format lives at
`.toad/runs/<id>/recording/<scenario-id>.json`, alongside the run's receipts.
Version 1 not-recordable status files identify the kind, scenario and intent
and contain only a fixed reason; they do not contain actions, assertions, or
secrets. A finalized recording envelope contains `version`, `status` (`recorded`),
`kind`, `scenarioId`, `intentHash`, `codec`, and codec-specific `payload`.
The built-in codecs are `cli-command-v1` (program, arguments, expected exit
and stdout) and `api-request-v1` (HTTP method, absolute URL, headers, body,
expected status and body). API capture uses `cli_run_structured_api` and
requires Node with fetch inside the sandbox. It supports literal body equality
or containment, only `accept`/`content-type` headers, and no redirects or
credential-bearing requests. Responses are bounded to 1 MiB and 30 seconds.
The same single-receipt, complete-attestation and credential-free restrictions
apply. URLs and request/response literals must be trusted non-secret test data;
URL overrides at replay, multi-step flows, dynamic values and JSON-field
assertions are not implemented. Unsupported scenarios use the normal agent.
 A codec validates its own producer provenance, actions,
assertions and credential rules, and no caller can register one at runtime.
Scenario
IDs are SHA-256 of UTF-8 JSON `["scenario", name.trim().toLowerCase()]`, as
scenario results use case-insensitive trimmed names. The intent fingerprint is
SHA-256 of UTF-8 JSON `[kind, steps, expected]`, with the original strings
preserved exactly. A status whose intent no longer matches is ignored. Status
publication is atomic and first-writer-wins; incomplete temporary files are not
read. Finalization and display require a finished run whose workflow completed
successfully, exactly one matching requested scenario with a PASS result,
matching intent, and successful validation by a codec built into Toad. The
scenario may be recorded even if another scenario failed. Codec validation is repeated when the
viewer reads a recording. Future producer codecs must define executable ordered
actions, checks, provenance and credential-reference handling, and verify that
the full expected outcome is covered before finalizing. An agent verdict or
receipt alone is not sufficient. Secret redaction is not proof that a recording
is safe: future producers must fail closed when they cannot establish safety.

Runs and their artifacts are gitignored, but **are not automatically pruned or
expired**. Delete run directories deliberately when no longer needed. Treat
all artifacts, including receipts, reports and transcripts, as potentially
sensitive; this status format does not sanitize other artifacts.

### Suites

A suite is `.toad/suites/<name>.yaml`: a handoff, plus tags and whether it
may change data. Commit it; like `toad.yaml` it holds no secrets.

```yaml
kind: web                      # web, cli or api
title: Checkout smoke
target:                        # omitted fields come from toad.yaml
  url: https://staging.example.com
goal: Check that a signed-in customer can buy one item.
tags: [smoke]
writes: true                   # it places orders; toad run needs --allow-writes
credentials:
  email: { env: TOAD_TEST_EMAIL }
  password: { env: TOAD_TEST_PASSWORD }
scenarios:
  - name: Adds to the cart
    steps: Sign in, open the first product, add it to the cart.
    expected: The cart badge shows 1.
  - name: Pays with the test card
    steps: Check out with card 4242 4242 4242 4242.
    expected: An order confirmation with an order number.
    tags: [payments]
limitations:
  - Use only the test card.
timeout_minutes: 10
```

Scenario names must be distinct: results come back by name. Every scenario
needs steps and an expected result. A suite without `writes: true` is told
it is read-only, and `toad run` refuses a suite with `writes: true` unless
you pass `--allow-writes`. (The read-only instruction is advisory: the agent
is asked not to change data, and nothing stops it from doing so.) Ask your
coding agent to save a suite after a handoff works, or start from
`suites/example.yaml`.

### toad run

```sh
toad run                                   # every suite
toad run --suite checkout --suite search   # these suites, in this order
toad run --tag smoke --max-scenarios 10    # tagged scenarios, at most 10, in file order
toad run --url "$PREVIEW_URL"              # test a preview deploy instead of the suite's URL
toad run --junit toad.xml --summary toad.md --json
```

Each suite is one Toad run, recorded under `.toad/runs/` and shown in
`toad ui` like any other. A scenario that does not pass is run once more (a
new run with only those scenarios; `--retries 0` turns this off,
`--retries 2` allows two more). A scenario that fails and then passes is
**flaky**: it does not fail the build, but the output, JUnit and summary all
say so.

| Exit code | Meaning |
|---|---|
| `0` | Every scenario passed (flaky ones included) |
| `1` | A scenario failed |
| `2` | A run errored, timed out, hit the spending limit or was interrupted, so a scenario's result is unknown |
| `3` | Toad could not start: no model key, invalid suites or options, a write suite without `--allow-writes`, a missing credential |

`--junit` writes one test case per scenario, with its attempts, report and
receipts folder; `--summary` writes markdown for a pull request comment or a
job summary; `--json` prints the whole result on stdout. `toad run --help`
lists every option.

### In CI

`toad run` needs nothing but a model key in the environment. On first use it
prepares the agent, and the browser if a web suite needs it, so there is no
`toad setup` step.

| What | How |
|---|---|
| **Model key** | The provider's variable, e.g. `ANTHROPIC_API_KEY`. `toad run` checks it before starting and exits 3 if it is missing. |
| **Models** | `--lead-model`, `--tester-model` or `--model`, else `models:` in `toad.yaml`, else what `toad setup` chose, else the agent's defaults. A run on other models uses a copy of the agent, so runs in progress are unaffected. |
| **Test credentials** | `--env TOAD_TEST_EMAIL,TOAD_TEST_PASSWORD` takes those names from the job's environment instead of `.toad/.env`. They are still referenced by name only and never written into handoffs or reports. |
| **CLI and API sandbox** | Docker on Linux runners. On a runner without Docker, Podman or Bubblewrap (macOS, Windows), `--sandbox none` runs the commands directly on the runner, in a copy of the project, with a minimal environment. It is never chosen automatically; receipts and the run page say when it was used. |
| **Spend** | `--max-cost 2` stops the runs once Pi has recorded $2 across them; the stopped run counts as an error (exit 2). Pi prices replies from its model catalog; a model it has no prices for counts as $0. |
| **Results** | Upload `.toad/runs/` as an artifact: it holds every report, receipt and transcript. |

A GitHub Actions job that tests each successful deployment and comments on
its pull request:

```yaml
name: Toad
on: deployment_status

jobs:
  toad:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.deployment.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Pin a release tag or commit you have reviewed.
      - run: npm install --global github:mihaiiova/toad#v0.7.0
      - id: toad
        run: echo "version=$(toad --version)" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/ms-playwright
            ~/.local/share/toad/agent
          key: toad-${{ runner.os }}-${{ steps.toad.outputs.version }}
      - name: Test the deployment
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TOAD_TEST_EMAIL: ${{ secrets.TOAD_TEST_EMAIL }}
          TOAD_TEST_PASSWORD: ${{ secrets.TOAD_TEST_PASSWORD }}
          # Through the environment, never pasted into the script.
          TARGET_URL: ${{ github.event.deployment_status.environment_url }}
        run: >
          toad run --tag smoke --url "$TARGET_URL"
          --env TOAD_TEST_EMAIL,TOAD_TEST_PASSWORD --max-cost 2
          --junit toad.xml --summary toad.md
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: toad-runs
          path: .toad/runs/
      - name: Post the summary
        if: always() && hashFiles('toad.md') != ''
        env:
          GH_TOKEN: ${{ github.token }}
          SHA: ${{ github.event.deployment.sha }}
        run: |
          cat toad.md >> "$GITHUB_STEP_SUMMARY"
          pr=$(gh pr list --state open --search "$SHA" --json number --jq '.[0].number')
          if [ -n "$pr" ]; then gh pr comment "$pr" --body-file toad.md; fi
```

`--url` replaces the URL of every selected web and API suite; select suites
that test the same deployment, or run `toad run` once per target.

## Reference

### Commands

| Command | |
|---|---|
| `toad setup [--yes] [--no-register] [--skip-browser] [--skip-image] [--force]` | Prepare or repair everything Toad needs |
| `toad doctor` | Check the agent, model key, browser, CLI sandbox and coding agents |
| `toad update` | Install the latest version from GitHub and prepare it |
| `toad run [options]` | Run the project's saved suites, e.g. in CI (see [Run tests on every deploy](#run-tests-on-every-deploy)) |
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
(`image` optional). For `"kind": "api"`, it is
`{ "url": "http://localhost:8080/api", "spec": "openapi.yaml", "workdir": "/abs/path", "image": "node:22-bookworm" }`;
only `url` is required, `workdir` (copied into the sandbox, with the spec and
any request bodies) defaults to the project, and `spec` is relative to it.
Fields left out of `target`, and the timeout, come from
`toad.yaml`; the handoff wins where both are set. Without scenarios, Toad
derives them from the goal.

The result has the report as text and as structured content: `verdict`
(`PASS`, `FAIL`, `ERROR`, or `UNKNOWN` when the report has none), `status`
(how the run itself ended: `ok`, `timeout`, `blocked`, `cancelled`, `error`,
`configuration_error`, `setup_failed`, `cost_limit`), `runId`, `scenarios` (each one's
`name` and `result`; a scenario the report left out is `ERROR` with
`missing: true`), `receipts` (the folder), `files`, `screenshots`, and for
project runs `run` (the run folder) and `cost` (the US dollars Pi recorded,
at its catalog prices). The
verdict never contradicts a scenario: any `FAIL` makes the run `FAIL`,
otherwise any `ERROR` makes it `ERROR`. A run that could not complete is a
tool error; a failing test is not.

A handoff may also carry a short `title`, which the run viewer shows instead
of the goal. Each run's page shows every scenario's result with its own
receipts, and has buttons that copy the handoff (all scenarios, or only those
that failed or errored) for your coding agent to run again.

### Where things live

Toad is installed once; everything about a project stays in that project.

| Where | What |
|---|---|
| `<project>/.toad/` | defaults, suites, secret values, runs |
| `~/.config/toad/` | `projects.json` (the viewer's list), `credentials.json` (model keys), `settings.json` (the chosen models) |
| `~/.local/share/toad/agent/<version>/` | the prepared agent; older versions are removed on update |
| `~/.local/share/toad/agent-variants/` | copies of the agent for runs on other models; rebuilt when the agent is |
| `~/.cache/toad/scenarios/` | CLI workspaces, removed after 7 days unused |
| `$XDG_RUNTIME_DIR/toad/` | run slots and per-run secret files (falls back to a private folder in the system temp directory) |

On Windows these are under `%APPDATA%\toad` and `%LOCALAPPDATA%\toad`.

### Settings

Environment variables, set where the MCP server is registered:

| Variable | Default | |
|---|---|---|
| The provider's key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …) | the saved key | The model key; overrides the one `toad setup` saved |
| `TOAD_MAX_CONCURRENT_RUNS` | `2` | Runs at once across every Toad server on the machine; further calls wait |
| `TOAD_CLI_SANDBOX` | `auto` | `container`, `bwrap`, `none` (no isolation; only when set), or `auto` (a running container runtime, else Bubblewrap) |
| `TOAD_CONTAINER_RUNTIME` | first that answers | `docker` or `podman` |
| `TOAD_CLI_IMAGE` | `node:22-bookworm` | Image for CLI tests when the project does not set one |
| `TOAD_COMMAND_TIMEOUT_S` | `120` | Time limit for each CLI command |
| `TOAD_SCENARIO_TTL_DAYS` | `7` | When unused CLI workspaces are removed; `0` keeps them |
| `TOAD_CONFIG_DIR`, `TOAD_DATA_DIR`, `TOAD_CACHE_DIR`, `TOAD_RUNTIME_DIR` | see above | Move Toad's per-user folders |
| `TOAD_AGENT_DIR` | the prepared agent | Use an agent somewhere else |

### How it is built

- **`agent/`**: the testing agent, a plain Pi project generated by
  [Faur](https://github.com/mihaiiova/faur); nothing of Faur runs in it. A
  lead plans the request into scenarios and hands each to a specialist
  (through [pi-subagents](https://www.npmjs.com/package/pi-subagents)): a
  web-tester that drives Chromium through the
  [Playwright MCP](https://github.com/microsoft/playwright-mcp), or a
  cli-tester or api-tester that runs commands through
  `agent/tools/toad-exec.mjs`, declared as commands for
  [pi-commands](https://github.com/mihaiiova/pi-commands). Its design is
  `agent/.pi/system.yaml`; the workflow is the `test` skill. The package
  ships this definition; `toad setup` copies it and installs its pinned Pi
  packages, and runs start `pi --mode json -p "/skill:test …"` in it with its
  own Pi home (`agent/.faur/pi-home`), as `agent/run` does.
- **`mcp/`**: the run engine (`run.mjs`), which runs the agent's workflow,
  enforces its time limit and cancellation (stopping every process the run
  started, including testers pi-subagents runs in the background), and maps
  its answer onto a verdict and per-scenario results; the MCP server
  (`server.mjs`) and `toad run` (`toad-run.mjs`), which both use it; the run
  viewer (`ui.mjs`); setup (`setup.mjs`, `agent.mjs`) and the `toad` command
  (`cli.mjs`). None of them holds testing logic.
- **`skills/toad-mcp/SKILL.md`**: the guide served to coding agents.

### How CLI and API tests run

API tests use the same sandbox: the api-tester sends each request with `curl`
from the prepared workspace, so every request is a receipt with its status
line, headers and body, and JSON checks run as separate recorded commands.

Preparing a scenario copies the project to a new workspace under
`~/.cache/toad/scenarios/<id>`, skipping symlinks, `.git`, `.faur`, `.forge`, `.toad`,
`receipts`, `.env` and `.env.*` (except `.env.example`), common credential
folders and private-key files. This is a name-based filter, not detection of
every secret: remove other credential files from the project first.
Preparation checks that the sandbox starts and that only the workspace and
its home are writable; the network variant also checks a given HTTP(S)
endpoint. A failed preparation is an infrastructure error; nothing ever runs
on the host instead, unless you ask for that with `--sandbox none`.

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

**With `--sandbox none`** (only when you pass it to `toad run`, or set
`TOAD_CLI_SANDBOX=none`), there is no isolation: commands run on the host as
your user, in the copied workspace, with only `PATH`, a `HOME` and `TMPDIR`
inside the workspace, and the selected credentials in their environment.
They can read and change anything your user can. Use it on disposable CI
runners, for trusted suites.

Either way, commands run through `/bin/sh`, with no input unless provided,
stop after 120 seconds, and each produces a receipt. Exact secret values of at
least four characters are redacted from recorded text, but redaction is not
comprehensive.

### Use the agent without MCP

From a git checkout whose agent you have set up with `cd agent && ./run`
(`/login`, then exit), run the `test` skill in Pi's print mode:

```sh
cd agent
./run --approve --no-context-files -p '/skill:test receipts: data/receipts/manual-1

Test https://demo.playwright.dev/todomvc. Add "buy milk", complete it; expected: "0 items left".' </dev/null
```

The report is printed when the run ends. Its first line is `Verdict: PASS`,
`FAIL` or `ERROR`, followed by a `Results:` block with one
`- PASS | <scenario name>` line per scenario. Pi's exit code says whether the
run completed, not whether the test passed. There is no time limit or
cleanup of background testers here; Toad adds those.

## Security and limits

**Toad runs with your permissions.** The agent, its tools and the browser run
as your user. Use it on code and sites you trust, with test accounts and
restricted keys.

**The CLI sandbox limits damage; it is not a security boundary for hostile
code.** Containers share the host kernel, and both backends allow network
access. Workspaces persist (until pruned) and may contain sensitive data.
Copying and workspace checks assume no hostile process of your user is racing
them. `--sandbox none` removes even that: commands run on the machine as your
user. Use it only on disposable CI runners.

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
- The model key is passed to the agent's environment. Pi passes that
  whole environment to its tools and subprocesses, and other processes of
  your user can read it. A tested program can send credentials over the
  network or write them into its workspace.
- After the run, Toad removes the per-run file. If a stopped run leaves a
  process running (cleanup incomplete), or the server is killed, it stays in the runtime folder's
  `secrets/` and the result names it; remove it once no process can still be
  using it.
- With `toad run --env NAME`, values come from the CI job's environment
  instead of `.toad/.env`; the same rules apply once they are read. The
  whole job environment, including other secrets, is inherited by the agent
  (as above), so give the job only the secrets its suites need.
- Redaction of the report and result is best effort. Screenshots, page
  content, logs, files, transformed values and the Pi session transcripts in
  `runs/<id>/sessions/` can still expose secrets; treat every run folder,
  and any CI artifact made from it, as sensitive.

**Paths are checked, not confined.** `project_path` must be absolute and
canonical; symlinked projects and `.toad` folders are rejected, and the `.env`
file is opened without following symlinks. These checks assume no hostile
process is changing the project at the same time.

**Web tests act on the site.** The browser clicks, types and submits forms.
Point it at test or staging environments. A suite's `writes: false` is an
instruction to the agent, not an enforced limit; `--allow-writes` only
decides which suites `toad run` starts.

**Spending limits are approximate.** `--max-cost` adds up the prices Pi
records for each reply, checked every two seconds, so a run can go slightly
over before it stops, and a model without catalog prices counts as free. Set
a limit with your provider too.

### Legacy tools

`run_web_test` and `run_cli_test` predate projects. They take `url`, or
`workdir` and `program`, plus `what`, optional `scenarios`, `secrets`,
`timeout_minutes` and (web) `screenshots`. Their receipts go to the agent's
`data/receipts`. Their `secrets` are names in the agent's shared
`.faur/test-secrets.env`, and that whole store is available to the run, not
only the names requested. Prefer `run_project_test`.

## Development

```sh
git clone https://github.com/mihaiiova/toad.git && cd toad
npm install
cd agent && ./run          # installs the agent's Pi packages; /login to a provider, then exit
cd .. && npm link          # `toad` now runs this checkout
npm test                   # MCP server, toad run, viewer, slots, launcher, and the CLI sandbox on every backend present
```

A checkout whose `agent/` has been set up this way is used in place of the
prepared copy. Change the agent with [Faur](https://github.com/mihaiiova/faur)
installed in your own Pi: run `pi` in `agent/` and use `/faur <request>`
(`/faur check` verifies it). Without Faur, edit its native files directly;
Faur reports such edits the next time it runs. `toad setup` with other models
edits the model fields of a checkout's agent in the same way.

### Releasing

`.github/workflows/test.yml` runs the tests on Linux, macOS and Windows for
every push. Installs come from GitHub for now: `main` is the latest, and each
release is a tag that installs and CI jobs can pin (`github:mihaiiova/toad#v0.7.0`).
Release a version with:

```sh
npm version minor          # or patch / major: updates package.json and tags
git push --follow-tags     # the release workflow tests the tag and publishes it to npm
```

Publishing to npm needs an npm automation token in the repository secret
`NPM_TOKEN`; until it is set, the workflow's publish step fails and the tag is
still installable from GitHub.

## License

[MIT](LICENSE)
