# Memory Index

## Project

- [e2ee is copied, not extracted](project_e2ee_copied_not_extracted.md) — protocol.ts is the SERVICE half and stays the only transcription; client code needing the client half is trimmed, not accommodated
- [drizzle-kit cannot change a column type](project_drizzle_kit_cannot_change_a_column_type.md) — no USING clause, and ADD CONSTRAINT before ADD COLUMN; split the schema edit across generate runs
- [oxlint anti-slop fix patterns](project_oxlint_anti_slop_patterns.md) — clean fixes for each anti-slop rule; no suppressions needed
- [oxlint promise(always-return) kills .then(setState)](project_oxlint_promise_always_return.md) — in a useEffect use an inner async function plus `void`, never a then-chain
- [Verification commands and the pre-push gate](project_verify_commands.md) — lint/typecheck/test:unit via ts-dev; the gate skips tests/integration
- [tests/integration must self-skip](project_integration_self_skip_guard.md) — a unit test enforces the TEST_API_KEY skip guard on every case
- [readdirSync recursive needs an encoding](project_node_readdirsync_recursive_typing.md) — without it the result types as (string | Buffer)[] and typecheck fails
- [pg-boss singletonKey needs a queue policy](project_pgboss_queue_policy_dedupe.md) — inert under `standard`; enrichment owns a `stately` queue set by createQueue AND updateQueue
- [import.meta.url asset reads die in the bundle](project_bundled_module_asset_reads.md) — lazy read, cwd fallback, and cut the static route edge that put it on the boot path
- [A union member with two literal states never narrows away](project_ts_union_member_with_two_literal_states.md) — `state: 'pending' | 'ready'` survives both exhaustive checks; one literal per member
- [RR8 fetcher.load is stable, the fetcher object is not](project_rr8_fetcher_load_is_stable.md) — depend on `fetcher.load`, never the fetcher, or a polling interval restarts every render and fires nothing
- [Transient typecheck failures in a shared worktree](project_transient_typecheck_failures_shared_worktree.md) — typegen sees a half-written routes.ts; re-run and md5 the file before diagnosing
- [Local-only sync_blobs reads sit outside the adapter](project_blob_usage_read_lives_outside_the_adapter.md) — select size_bytes, never getBlob; the adapter mirrors upstream and must stay drift-free
- [key-records answers the document, not the port](project_key_records_envelope_is_the_document.md) — `records` on GET, a BARE record on PUT; the 409 keeps `error` beside `currentUpdatedAt` on purpose
- [The local-store barrel is the one seam](project_local_store_barrel_is_the_one_seam.md) — `getPrimaryStore` is re-exported for SUBSCRIBING; deep-importing persist.ts bypasses the save lock
- [Toast a mutation from an effect, not the render](project_toast_after_client_action.md) — sonner mid-render warns, and `t` in the deps re-fires it on a language change
- [One projection decides the blob's keys](project_one_projection_decides_the_blob_keys.md) — readLocalSnapshot feeds toSyncedSnapshot and takes `{ store }`; blob-schema.ts must stay free of the token `history`
- [sync-client schemas pin the document](project_sync_client_schemas_pin_the_document.md) — all four wire schemas are exported so a test can parse a PROTOCOL.md literal through them
- [root's clientLoader keeps offline mutations alive](project_root_clientloader_offline_revalidation.md) — every clientAction revalidates root's server loader over uncacheable `.data`; only a network failure is absorbed
- [root data's `headers` is an all-undefined method bag on the client](project_root_data_headers_serialized.md) — single fetch strips methods, so a fallback cannot return `combineHeaders()`
- [A public /api/v1 route needs a bearer-guard exemption](project_api_v1_bearer_guard_exemptions.md) — an Express 401 lands before the router; route-level tests never see it
- [The LLM registry owns the audio call too](project_llm_registry_owns_the_audio_call.md) — @sprqvntrs/llm has no audio input; use registry.transcribeAudio, fake it with withAudioPort
- [Sync triggers, and the locked-but-signed-in state](project_sync_triggers_and_locked_state.md) — an empty outbox never pulls, and a reload leaves a device signed in with no data key
