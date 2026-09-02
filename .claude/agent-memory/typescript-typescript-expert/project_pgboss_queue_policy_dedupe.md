---
name: pgboss-queue-policy-dedupe
description: A pg-boss singletonKey is inert unless the QUEUE carries a deduping policy; enrichment owns the 'enrichment' queue with policy 'stately'
metadata:
  type: project
---

In pg-boss 10.4.2 every unique index over `singleton_key` is policy-gated
(`job_i1` short, `job_i2` singleton, `job_i3` stately). Under the default
`standard` policy the key is stored and enforces nothing, so a `singletonKey`
passed to `orchestrator.start()` dedupes nothing at all.

**Why:** dedupe is a QUEUE property, not a per-send property. `@sprqvntrs/workflows`
0.2.5 calls `boss.createQueue(name)` with no options, and pg-boss's `create_queue`
is `ON CONFLICT DO NOTHING`, so neither the library nor a restart can ever set or
repair a policy. Ten concurrent enqueues produced ten jobs and ten paid provider
calls.

**How to apply:** enrichment has its own queue, `ENRICHMENT_QUEUE` in
`app/lib/enrichment/limits.ts`, with policy `stately` forced in
`initializeWorkflows` by calling BOTH `boss.createQueue(...)` and
`boss.updateQueue(...)`: create cannot repair an existing wrong policy, update
cannot create. `stately` (unique per queue+state+key up to `active`) is chosen
over `short` (only dedupes `created`), because only `stately` bars two ACTIVE
runs for one key. Any future queue that needs dedupe needs its own name plus the
same two-call pair, never a policy on the shared `default` queue.
