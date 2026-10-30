<!-- forge:generated v1 sha256=04279e704ad0106c05835301622244a7397c4c48c1ac113600691175fdff1da1 -->
# revisor

Tests web apps end to end with Playwright and returns the results with screenshots.

## Run

The generated `./run` launcher is the entry point. It starts Pi with the
project's own isolated config directory so your global Pi settings, MCP
servers, extensions and credentials are not inherited. Skills in the shared
Agent Skills folder (`~/.agents/skills/`) do load, for the orchestrator.

```sh
./run             # interactive
./run -p "..."   # headless one-shot
./run --workflow test
```

Named workflow runs accept `--input key=value` (repeatable), `--timeout 30m`
(default 30m; units s, m or h), and `--allow-concurrent` to bypass the
default per-workflow lock. They require Node.js, and run the workflow runner
from the Forge package pinned in `.pi/settings.json`.
Run interactive `./run` once to install project packages before the first
named workflow; its installed Forge package validates system.yaml before Pi starts.
Regenerate after changing declarations so derived files stay current.
The final stdout line is JSON with workflow, runId, status, answer and
an optional message. Exit codes: 0 success, 1 agent/tool failure,
2 configuration/lock failure, 3 approval required, 4 timeout.
When available, Forge starts a private systemd user scope and stops it on
exit. The fallback is process-group termination plus stop requests for
pi-subagents runs in this invocation's isolated temporary state. The result
reports `cleanup: incomplete` and retains `stateDir` if cleanup is unconfirmed.
Independently detached processes can survive the fallback cleanup.
Approval is never granted unattended. Entry delegation and boundary
instructions are model-directed, not a hard guarantee of execution.

Authenticate inside `./run` with `/login`, or export
`PI_API_KEY` / a provider key. See the policy section below for which
capabilities are enforced vs advisory.

## Maintain

`/forge <request>` proposes a change; when the turn ends, Forge shows the
preview for you to approve or decline. `/forge review` is read-only.
`/forge check` verifies the agent, `/forge status` summarizes it, and
`/forge sync` moves to the newest Forge release after two confirmations.
Roll back with git. `/forge permissions` lists the commands agents may run
and adds, removes or reviews them; agents ask for a command they need with
`request_permission`. Restart `./run` when the launcher or packages change.

## Policy

### Enforced (cannot be bypassed)

None declared.

### Advisory (guidance — not enforced)

None declared.
