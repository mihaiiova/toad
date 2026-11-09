# Spec #24 workflow amendment

## Amendment — 2026-11-09: implementation workflow

At the user's explicit request, begin implementation in the current session rather than requiring a fresh-session handoff. The user also supersedes the default red-green execution cadence: implement in vertical slices and add the acceptance/regression tests, but defer running tests and packaging checks until the end of this child implementation. Acceptance criteria and testing seams are unchanged; no unexecuted test is claimed passing. Leave the spec branch unmerged and do not start blocked children or silently close the epic. Reason: the user requested immediate implementation and end-of-implementation testing.

Spec: https://github.com/mihaiiova/toad/issues/24
