# Memory Index

## Project

- [e2ee is copied, not extracted](project_e2ee_copied_not_extracted.md) — protocol.ts is the SERVICE half and stays the only transcription; client code needing the client half is trimmed, not accommodated
- [drizzle-kit cannot change a column type](project_drizzle_kit_cannot_change_a_column_type.md) — no USING clause, and ADD CONSTRAINT before ADD COLUMN; split the schema edit across generate runs
- [oxlint anti-slop fix patterns](project_oxlint_anti_slop_patterns.md) — clean fixes for each anti-slop rule; no suppressions needed
- [Verification commands and the pre-push gate](project_verify_commands.md) — lint/typecheck/test:unit via ts-dev; the gate skips tests/integration
- [tests/integration must self-skip](project_integration_self_skip_guard.md) — a unit test enforces the TEST_API_KEY skip guard on every case
- [readdirSync recursive needs an encoding](project_node_readdirsync_recursive_typing.md) — without it the result types as (string | Buffer)[] and typecheck fails
- [pg-boss singletonKey needs a queue policy](project_pgboss_queue_policy_dedupe.md) — inert under `standard`; enrichment owns a `stately` queue set by createQueue AND updateQueue
- [import.meta.url asset reads die in the bundle](project_bundled_module_asset_reads.md) — lazy read, cwd fallback, and cut the static route edge that put it on the boot path
- [A union member with two literal states never narrows away](project_ts_union_member_with_two_literal_states.md) — `state: 'pending' | 'ready'` survives both exhaustive checks; one literal per member
- [RR8 fetcher.load is stable, the fetcher object is not](project_rr8_fetcher_load_is_stable.md) — depend on `fetcher.load`, never the fetcher, or a polling interval restarts every render and fires nothing
- [Transient typecheck failures in a shared worktree](project_transient_typecheck_failures_shared_worktree.md) — typegen sees a half-written routes.ts; re-run and md5 the file before diagnosing
