# Epic #23 implementation amendment

## Amendment — 2026-11-09: stacked implementation and end-stage validation

The user explicitly requested proceeding with the remaining epic items and testing at the end. Supersedes the default requirement to finish review/merge/closure of each predecessor before beginning dependent implementation, the fresh-session handoff, separate per-child implementation branches, and the red-green test-execution cadence for this batch. Approved behavior: implement #25, then #26/#27/#28 sequentially with one writer on `epic/23-general-testing-improvements`, starting from #24 checkpoint `7592989`. Preserve logical dependencies in code, add acceptance/regression tests as each slice is built, and execute them only after the remaining batch is implemented. Predecessor code being locally available does not mean its spec is reviewed or done.

No merge, push, release or issue closure is authorized. Formal review and integration remain pending; GitHub blockers continue to describe delivery dependencies. Do not claim unexecuted checks as passing, and do not discard tests to reduce scope. #28's paid real-tester baseline still requires separate budget authorization and must be reported pending if not performed. This reversible stacked branch avoids repeatedly blocking requested implementation on lifecycle ceremony while keeping the spec and branch consistent.
