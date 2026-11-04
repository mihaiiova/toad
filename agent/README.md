<!-- faur:generated v1 sha256=47d21914decc3e4894a375058622861121fbebc4faca66d5c2334da3c0c6c750 -->
# toad

Tests web apps, command-line programs and HTTP APIs end to end and returns the results with receipts.

## Run

Start it with `./run`. It runs Pi with this project's own Pi configuration
and logins instead of yours, so a package you installed (such as an MCP
extension that replaces Pi's built-in MCP) cannot change what this project
relies on. Plain `pi` here also works, with your configuration added;
`/faur check` reports what in it conflicts.
Your environment, including any credentials in it, is inherited; this is not
an OS sandbox. Skills in `~/.agents/skills/` and `AGENTS.md` files in parent
folders also load, for the orchestrator. Pi asks once whether to trust the
project; headless runs pass `--approve` instead.

```sh
./run                       # interactive
./run --approve -p "..."    # headless one-shot
./run --approve -p "/skill:test <request>"
```

A workflow is a skill: the text after it is the request. Print mode exits 0
with the final answer on stdout, or non-zero with the error on stderr; the
exit code reports the run, not whether the task succeeded. Add
`--mode json` for an event stream. Pi waits for stdin to close when it is
not a terminal, so callers close it. Approval is never granted unattended:
a call that asks the user is refused in a headless run.

On the first interactive run, Pi may start npm package installation processes
that continue briefly after Pi exits and may keep output pipes open. Callers
should allow extra time before assuming the output stream has closed.

Authenticate with `/login` inside `./run`, or export the provider-specific key (for
example `DEEPSEEK_API_KEY`). See the policy section below for which
capabilities are enforced vs advisory.

## Maintain

This project runs on Pi alone and pins no Faur package. Maintain it from
your own Pi with Faur installed: run `pi` in this folder and use
`/faur <request>` to propose a change (discuss, apply or discard it when the
turn ends), `/faur check` to verify the agent, `/faur status` to summarize
it and `/faur permissions` to list, add or remove declared commands. Without
Faur, edit the files directly; roll back with git. Restart Pi when packages change.

## Policy

### Enforced by Pi's tool layer

- Declared commands run without a shell, with only their {placeholders} filled in; none asks before running (pi-commands, `git:github.com/mihaiiova/pi-commands@v0.1.0`).

An agent with `bash` or a shell-like command can still reach anything your user account can.

### Advisory (guidance — not enforced)

- `lead` is told it has no MCP tools; it is not prevented from calling them, and its specialists have them anyway.
