#!/usr/bin/env bash
# Forge runs this integration in a trusted process environment. A wrapper run
# can select a per-run secrets file and receipts folder (inside the project's
# .toad/runs/<id>/); direct and legacy runs keep the agent's own defaults.
# The browser server starts inside the receipts folder, so a screenshot saved
# under a relative name lands there too, never in the agent's folder.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${TOAD_RECEIPTS_DIR:-$ROOT/data/receipts}"
SECRETS="${TOAD_PLAYWRIGHT_SECRETS_FILE:-$ROOT/.forge/test-secrets.env}"
mkdir -p "$OUT"
cd "$OUT"
exec npx "$@" --output-dir "$OUT" --secrets "$SECRETS"
