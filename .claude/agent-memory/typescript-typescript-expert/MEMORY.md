# Memory Index

## Project
- [oxlint anti-slop fix patterns](project_oxlint_anti_slop_patterns.md) — clean fixes for each anti-slop rule; no suppressions needed
- [Verification commands and the pre-push gate](project_verify_commands.md) — lint/typecheck/test:unit via ts-dev; the gate skips tests/integration
- [tests/integration must self-skip](project_integration_self_skip_guard.md) — a unit test enforces the TEST_API_KEY skip guard on every case
- [readdirSync recursive needs an encoding](project_node_readdirsync_recursive_typing.md) — without it the result types as (string | Buffer)[] and typecheck fails
- [pg-boss singletonKey needs a queue policy](project_pgboss_queue_policy_dedupe.md) — inert under `standard`; enrichment owns a `stately` queue set by createQueue AND updateQueue
- [import.meta.url asset reads die in the bundle](project_bundled_module_asset_reads.md) — lazy read, cwd fallback, and cut the static route edge that put it on the boot path
