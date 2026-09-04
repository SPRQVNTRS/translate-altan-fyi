# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) — short markdown files documenting significant choices we've made about how this codebase is built. The point is not bureaucracy; it's so that six months from now somebody (often us) can ask "why did we do it this way?" and find a real answer instead of guessing from the code.

## When to write an ADR

Write one whenever you make a decision that:

- Constrains future work in a non-obvious way (e.g. picking a transport, a tenancy model, a framework)
- Has a clear alternative we considered and rejected
- Would be expensive to reverse (DB schema shape, public API contracts, build tooling)
- A future contributor might second-guess without context

Skip it for routine local choices — naming a function, picking between two equivalent libraries for a one-off, choosing a CSS color. ADRs are for the stuff that bites you when you forget.

## Workflow

1. Copy `0000-template.md` to the next zero-padded number — `NNNN-kebab-case-title.md`.
2. Fill in: **Status** (Proposed / Accepted), **Context**, **Decision**, **Consequences**.
3. Add the ADR to the index below, in [AGENTS.md](../AGENTS.md#index), and in the [README](../README.md#architecture-decisions).

## Keeping them current

**These ADRs describe the system as it is now, not as it once was.** An ADR that
no longer matches the code is worse than no ADR — it is a confident wrong answer,
and it will be believed.

So:

- **A decision changes → edit the ADR in place.** Fix the Decision, and fix any
  Context or Consequences that the change made false.
- **A decision is wholly reversed and its ADR has nothing left to say → delete
  it.** Do not leave a superseded husk in the directory. Git history is the
  archive; the directory is the current state.
- **A decision is reversed but the *reasoning* still earns its keep → keep one
  ADR on the topic and fold the history into its Context**, as a short paragraph
  explaining what was tried and why it did not hold. That is how ADR-0007 carries
  the brief TypeScript 6 pin.

Numbers are stable identifiers — commit messages cite them. Reuse a number for
the same topic, never renumber an existing file, and accept gaps in the sequence
when an ADR is deleted.

The bar for a new ADR versus an edit: a genuinely new decision with its own
context gets a new number. A course correction on a decision already recorded
gets an edit.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-cli-wraps-the-api.md) | CLI wraps the API | Accepted |
| [0002](0002-data-migrations.md) | Data migrations alongside schema migrations | Accepted |
| [0003](0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) | Superseded by 0010 |
| [0004](0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint | Accepted |
| [0005](0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint + anti-slop is the lint gate | Accepted |
| [0007](0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 | Accepted |
| [0008](0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared | Superseded by 0011 |
| [0009](0009-invite-only-accounts.md) | Invite-only accounts, bootstrapped by a one-shot token | Superseded by 0011 |
| [0010](0010-drop-the-inherited-tenancy.md) | Drop the inherited tenancy, org and CMS surfaces | Accepted |
| [0011](0011-plain-accounts-replace-the-encrypted-layer.md) | Plain accounts replace the encrypted layer | Accepted |
