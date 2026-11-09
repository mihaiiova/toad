# Structured web scenarios

`node tools/toad-structured-web.mjs [request-file]` reads JSON from that file
or stdin and runs the steps once, in a fresh isolated headless browser (the
same pinned Playwright MCP server the web-tester uses), with no secrets and no
model call.

```json
{"receipts":"data/receipts/adds-a-note","name":"01-structured","payload":{"steps":[
  {"action":"goto","url":"http://localhost:3000/notes"},
  {"action":"fill","target":{"label":"Note"},"value":"Buy milk"},
  {"action":"click","target":{"role":"button","name":"Add"}},
  {"action":"expectText","target":{"role":"list","name":"Notes"},"contains":"Buy milk"},
  {"action":"expectUrl","path":"/notes"}
]},"capture":{"scenarioName":"Adds a note","complete":true}}
```

In project runs, `TOAD_WEB_TARGET_URL` binds navigation to the effective
handoff target. A `goto` may use a root-relative path such as `/pricing`;
it is resolved against that target and stored as the resolved URL. Absolute
URLs must stay under the target's origin and path prefix. Browser navigation
is also checked at runtime, including clicks and redirects. This is not a
network sandbox: subresources and trusted page scripts may contact other hosts.
Use target-relative paths in suite instructions; don't change expected text.

Steps, 2 to 30, in order: `goto` (root-relative when target-bound, otherwise
absolute http(s), with no user info or fragment), `click`, `fill` (literal value, at most 1024 characters), and the
checks `expectVisible`, `expectText` (literal `contains`) and `expectUrl`
(path and query, starting with `/`). The first step is a `goto` and the last a
check. A `target` is `{role, name}`, `{label}` or `{text}`, matched exactly; it
must match one visible element. Roles are a fixed set of ARIA roles (button,
link, textbox, checkbox, radio, combobox, heading, listitem, and so on; see
`ROLES` in toad-web-recording.mjs).

The result is `pass`, `fail` (a step or check did not hold) or `error` (the
page could not load, the browser could not start, or the run was refused).
The receipt, `<receipts>/<name>.txt`, lists every step and the result; it is
never overwritten, so use a new name for another run.

Use only trusted, explicitly non-secret fixtures. The tool refuses any run
with credentials, locators, values or URL query names that look like sign-in,
password, token, session or card fields, and stops before filling a password,
hidden or one-time-code input. It cannot recognize arbitrary secrets.

Capture is optional and requires `TOAD_RECORDING_ENABLED=web-v1`, supplied by
the project runner. `complete:true` attests that these steps and checks cover
the entire scenario; this is a tester trust assumption, not a mechanical
proof. `captured:true` means a candidate was written beside the receipt, not
that it was finalized. Finalization requires the scenario to PASS, this to be
its only structured run, and the handoff to have no credentials. `toad run`
replays a saved suite's recording the same way, without a model.
