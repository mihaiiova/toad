# Structured HTTP assertions

`node tools/toad-structured-api.mjs [request-file]` reads JSON from that file
or stdin. Prepare a scenario with Toad's existing network preparation tool
first. Supply a URL reachable from inside the sandbox (in a container the
host is `host.docker.internal`, not localhost).

```json
{"scenario":"SCENARIO-ID","receipts":"data/receipts/health","name":"01-request","payload":{"method":"GET","url":"http://host.docker.internal:3000/health","headers":{},"body":"","expect":{"status":200,"body":{"contains":"healthy"}}},"capture":{"scenarioName":"Health","complete":true}}
```

The sandbox needs Node with built-in fetch. Supported methods are GET, HEAD,
POST, PUT, PATCH and DELETE. Request headers are restricted to lower-case
`accept` and `content-type`. Body assertions use exact `equals` or literal,
nonempty `contains`. Request literals and expected bodies are limited to
1024 characters each. Redirects are not followed. Responses are bounded to
1 MiB and requests to 30 seconds. The response status and body are written to
the command receipt. Transport failures are ERROR; assertion mismatches FAIL.

Use only trusted, explicitly non-secret fixtures. Credential-selected runs are
rejected, even for commands that don't use the credential. URLs, bodies,
headers, expected values and responses can contain secrets; the tool cannot
recognize arbitrary secrets. Do not use authentication or sensitive endpoints.

Capture is optional and requires `TOAD_RECORDING_ENABLED=api-v1`, supplied by
the project runner. `complete:true` attests that this single request and these
assertions cover the entire scenario; this is a tester trust assumption, not
a mechanical proof. `captured:true` means a candidate was written, not that it
has been finalized. Finalization requires the scenario to PASS, the matching
receipt to be its only command receipt, and no credentials, setup, PATH
additions or runtime installs. Unsupported scenarios use the normal tools.

This is run-local recording only; suite saving and production replay are
separate work. The deterministic replay helper is for proof/testing and uses
the recorded absolute URL as-is. Never replay write requests against production.
