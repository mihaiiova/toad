---
name: revisor-mcp
description: Plan and run independent web or CLI tests with the Revisor MCP server. Use when a user asks Revisor to test an application, website, CLI, or end-to-end workflow, or when preparing a project-local testing handoff and interpreting its reports and receipts.
---

# Revisor MCP testing

Revisor is a separate testing agent: give it a runnable target, a specific goal, and observable scenarios. Do not assume it has your conversation, project knowledge, server processes, credentials, or approval for side effects. Discover the available Revisor MCP tools and their current schemas in your client before calling them; deployed versions may differ from this guide. If the server is unavailable, report that rather than claiming a test ran.

## Prepare the handoff

1. Inspect the project, relevant instructions, documentation, configuration, and the change to understand what needs testing. Identify the real entry point, working directory, dependencies, startup and build commands, configuration, test data, and observable outcomes. Do not put secret values in the handoff.
2. Decide which behaviors and failure cases matter. Translate them into named scenarios with actionable steps and concrete expected results. Include setup and teardown instructions, preconditions, safe test data, and relevant constraints in the goal, steps, or limitations. State what is out of scope. Ask the user for missing decisions or authorization when you cannot safely infer them.
3. For web tests, supply a reachable URL and ensure the application and required services are running for the duration. `localhost` is relative to Revisor's environment; verify reachability rather than assuming it. Prefer staging and test accounts. Disclose any state-changing operations and obtain authorization before actions that affect real data or external services.
4. For CLI tests, supply an absolute working directory and the exact invocation. Determine whether the program needs installed dependencies, network access, input, environment variables, accounts, or writable files. CLI tests run in a copied workspace, not the original project. Setup skips symlinks, `.git`, `.forge`, `.revisor`, `.env` files (except `.env.example`), and other credential-like paths; check that the copy will contain what the test needs. Name-based filtering does not catch every secret: ask the user to remove other sensitive files before a copy. Network is shared, including localhost and reachable LAN services. This is not a hardened sandbox; use trusted workloads.
5. Choose a canonical, absolute project path without symlinks or `..`. Call `setup_project` before the first project run. It creates `.revisor/` without overwriting files and checks its ignore rules. If setup reports unsafe existing rules, inspect them and ask before changing user files. Treat handoffs, reports, screenshots, command output, retained workspaces, and receipts as potentially sensitive.

## Project handoff

Prefer `run_project_test` for project-local records. The following is the tool's argument object, not a request to paste into a shell:

```json
{
  "project_path": "/absolute/canonical/project",
  "handoff": {
    "version": 1,
    "kind": "web",
    "target": { "url": "http://localhost:3000" },
    "request": {
      "goal": "Verify the todo flow using disposable test data.",
      "scenarios": [
        { "name": "Create and complete", "steps": "Add a todo named Review, then complete it.", "expected": "The todo is marked complete and the active count decreases." }
      ]
    },
    "limitations": ["Do not modify existing user data."]
  },
  "screenshots": "paths"
}
```

For a CLI handoff use `"kind": "cli"` and `"target": { "workdir": "/absolute/canonical/project", "program": "node dist/cli.js" }`; replace the scenario with the actual commands, input, and expected output and exit codes. `timeout_minutes` is optional. The server writes a handoff, report, and copied receipts under `.revisor/runs/<run-id>/`; original receipts may also remain under the Revisor agent's `data/receipts`. Verify paths returned by the tool rather than inventing them. The user can browse all past runs in a localhost web viewer with `node .revisor/history.mjs`.

## Credentials and trust

- Never ask for or transmit secret values in chat, handoffs, scenarios, commands, logs, or reports. For supported web project tests, ask the user to put test-only values in the project's `.revisor/.env` themselves, then reference names only, for example `"credentials": { "email": { "env": "REVISOR_TEST_EMAIL" }, "password": { "env": "REVISOR_TEST_PASSWORD" } }`. Names must be valid environment variable identifiers. The file uses `NAME=value` lines, not shell expansion. Never read it just to verify values; let the tool validate references.
- Project CLI tests also accept credential references. Only the named variables are passed to the sandboxed command; use `$NAME` in commands, never a value. Certain environment names that can alter process startup are reserved and rejected. A CLI program can transmit secrets over the shared network or write them to persistent artifacts, so use trusted programs and restricted, budget-limited test keys.
- Legacy `run_web_test` and `run_cli_test` use Revisor's shared `agent/.forge/test-secrets.env`, not the project's store. The shared store may be exposed to the test process beyond the names requested; never use this as a silent substitute for project-owned or least-privilege credentials. Use it only with informed authorization and an accepted trust boundary.
- Project web credentials are resolved by name into a temporary per-run file, not a per-tool security boundary. Revisor's agents, tools, subprocesses and same-user processes may access them. Screenshots, output, files and transformed values may expose secrets; redaction is best effort. Run only trusted workloads, and tell the user that artifacts can contain sensitive information. Cleanup may be incomplete after cancellation or failure; follow the server's reported cleanup guidance and do not remove files while processes might still use them.

## Execute and report

Call the discovered tool with the complete handoff. Revisor runs can take minutes; respect progress and timeout behavior. Do not start duplicate runs merely because the first is slow. A failing test verdict is different from an execution or infrastructure error: inspect both `status` and `verdict`. Report PASS, FAIL, ERROR, or unknown accurately, including scenario-level evidence, actual versus expected behavior, and paths to reports and receipts. If the run is blocked, cancelled, times out, or has missing evidence, say what was not verified. Avoid reproducing secret-bearing output. Investigate failures before attributing them to the application; do not silently change the target or weaken scenarios to make a run pass.
