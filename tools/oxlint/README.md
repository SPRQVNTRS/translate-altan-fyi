# Vendored lint tooling

## `anti-slop/`

A **vendored copy** of a third-party oxlint plugin. It is not ours, and it is
not an npm dependency — oxlint loads it from this path.

| | |
|---|---|
| **Source** | <https://github.com/dmmulroy/anti-slop> |
| **Author** | Dillon Mulroy ([@dmmulroy](https://github.com/dmmulroy)) |
| **License** | MIT — see [`anti-slop/LICENSE`](anti-slop/LICENSE) |
| **Vendored from** | commit [`446268e`](https://github.com/dmmulroy/anti-slop/commit/446268e5d15baa968eaec669ff65358d36ae6259) (2026-08-14) |
| **Vendored on** | 2026-08-16 |
| **Loaded by** | `.oxlintrc.json` → `jsPlugins[].specifier` |
| **Why it matters here** | [ADR-0005](../../.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) |

### What was copied

Upstream's `src/` directory, verbatim — 15 rules, three shared modules, and
`index.ts`. Two deliberate deviations:

- **Omitted:** upstream's 12 `*.test.ts` files. They test the rules themselves,
  not this repo's code, and running them is upstream's job.
- **Added:** `LICENSE`, taken from the upstream repository root. MIT requires the
  copyright and permission notice to travel with copies of the software, and the
  notice does not live inside `src/`.

**Do not edit anything under `anti-slop/`.** A local change is invisible at the
next re-vendor and will be silently overwritten. If a rule is wrong, open an
issue upstream; if a rule does not fit this repo, turn it off in `.oxlintrc.json`
with a documented reason (the existing ones are tabulated in AGENTS.md).

### Checking for drift

Vendoring buys control and costs automatic updates. Nothing notifies us when
upstream changes, so the check is manual:

```bash
git clone --depth 1 https://github.com/dmmulroy/anti-slop /tmp/anti-slop
diff -r --exclude='*.test.ts' --exclude='LICENSE' \
  /tmp/anti-slop/src tools/oxlint/anti-slop
```

Silence means the copy is current. To re-vendor: copy `src/` over
`anti-slop/`, re-copy `LICENSE`, run `pnpm lint`, fix any new findings in *our*
code, and update the commit and date in the table above.

### Do not "fix" this by installing from npm

There is a package named `oxlint-plugin-anti-slop` on the public npm registry.
**It is not this project.** It is a 62-byte, `0.0.0`, dependency-free placeholder
published by an unrelated account — the real project's package name, squatted.

Upstream's own `package.json` is `"private": true` and has never been published.
The project ships two installation paths, both of which are copies: an agent
skill that performs the copy for you, and the manual copy documented above. There
is no dependency to install, so an "upgrade" that adds one is pulling a
stranger's code into the linter that runs on every edit and every commit.
