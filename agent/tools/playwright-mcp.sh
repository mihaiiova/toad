#!/usr/bin/env bash
# Forge runs this integration in a trusted process environment. A wrapper run
# can select a per-run secrets file; direct and legacy runs keep their store.
set -euo pipefail
exec npx "$@" --secrets "${TOAD_PLAYWRIGHT_SECRETS_FILE:-.forge/test-secrets.env}"
