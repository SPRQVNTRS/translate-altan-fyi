# CLI Reference

The CLI (`pnpm cli`) provides Laravel-style commands for managing the application.

## Commands


### Data Migrations

```bash
pnpm cli data-migration run   # Apply all pending data migrations (deploy step)
pnpm cli data-migration list  # List applied and pending migrations
```

Migration files live at `drizzle/data-migrations/migrations/<YYYY-MM-DD>-<slug>.ts`.
Each file exports `default async function (db): Promise<void> { ... }`.
See ADR-0002 and [AGENTS.md > Data Migrations] for rationale and conventions.

### Database

```bash
pnpm cli db check          # Verify connection
pnpm cli db pool           # Pool statistics
pnpm cli db tables         # List tables
pnpm cli db describe <tbl> # Describe schema
pnpm cli db query <sql>    # Execute SQL
```

### Users

```bash
pnpm cli user list
pnpm cli user get <id>
pnpm cli user find <email>
pnpm cli user activate <id>
pnpm cli user deactivate <id>
pnpm cli user grant-superadmin <id>
pnpm cli user revoke-superadmin <id>
```

### Organizations

```bash
pnpm cli org list
pnpm cli org get <id>
pnpm cli org members <id>
pnpm cli org delete <id>
```

### Workflows

```bash
pnpm cli workflow list
pnpm cli workflow get <id>
pnpm cli workflow operations <id>
pnpm cli workflow context <id>
pnpm cli workflow cancel <id>
pnpm cli workflow stats
```

### Operations

```bash
pnpm cli operation list
pnpm cli operation get <id>
pnpm cli operation data <id>
pnpm cli operation logs <id>
pnpm cli operation find <workflowId>
pnpm cli operation stats
```

### Dictionary imports

Load an open-data dump into the shared dictionary zone. These commands talk to
Postgres directly, which is a documented exception to ADR-0001; the amendment in
`.adr/0001-cli-wraps-the-api.md` says why.

The importers NEVER download. Fetch the dump yourself into `.data/` (gitignored)
and pass the path.

```bash
# Wikidata lexemes, CC0. About 1.58 million lexemes in the full dump.
pnpm cli import wikidata-lexemes --file .data/latest-lexemes.json.bz2

# Tatoeba, CC BY 2.0 FR, plus a second CC0 source row for the relicensed list.
pnpm cli import tatoeba \
  --file .data/sentences_detailed.tar.bz2 \
  --links .data/links.tar.bz2 \
  --cc0 .data/sentences_CC0.tar.bz2

```

Shared options:

| Option | Meaning |
|--------|---------|
| `-f, --file <path>` | Local dump. Required. |
| `-l, --languages <codes>` | Comma separated, default `en,de,tr,es`. Anything else is a hard drop. |
| `-m, --max-rows <n>` | Stop after N source rows. This is the memory bound, not just a smoke-test flag. |
| `--dry-run` | Parse and count, write nothing. |
| `--json` | Print the summary as JSON. Progress still goes to stderr. |

Every importer is idempotent: it upserts on a natural key, so a second run over
the same dump writes zero new rows. Each prints a summary of rows read, rows
written, and rows dropped with a count per reason.

**What the Wikidata importer writes.** One `headwords` row per lexeme, on the
natural key `(language, lemma, pos)`. One `senses` row per Wikidata sense,
carrying the upstream id verbatim in `external_id`, so `L9-S1` is ONE sense
however many languages gloss it. One `sense_versions` row per gloss language,
all at version 1, held apart by the unique key on
`(sense_id, gloss_language_code, version)`. A gloss in a language outside
`--languages` is dropped and counted.

**Translation edges.** Statement `P5972` ("translation") on a sense becomes
`translations` rows in BOTH directions at confidence 1.0, once both endpoints
resolve to sense rows we wrote; a pair whose target is not in a served language
is counted under `translation-target-missing`. A `deprecated` rank, a snak with
no value, and a statement pointing at its own sense are skipped. `P5973`
("synonym") is NOT imported: it is a same-language relation, and `translations`
is the cross-language surface the reader is served from.

**Memory.** Tatoeba holds a map of every kept sentence, about 4.0 million rows
for the four languages. `--max-rows` caps pass 1, which is what bounds that map.
It does NOT cap pass 2, which always streams all 28.4 million links.

Where the dumps come from:

- Wikidata: `https://dumps.wikimedia.org/wikidatawiki/entities/latest-lexemes.json.bz2`
- Tatoeba: `https://tatoeba.org/en/downloads`
There were three importers. PanLex was dropped by operator decision: its upstream
is gone. `db.panlex.org` and `api.panlex.org` both answer NXDOMAIN, and
`panlex.org/snapshot/` soft-404s to the homepage. The Internet Archive's last
capture of the listing is 2025-11-13, showing snapshots up to
`panlex-20251101-csv.zip`, and it does not hold the zips. A CC0 mirror exists at
`cointegrated/panlex-meanings` on Hugging Face, from the 2024-03-01 snapshot, if
the decision is revisited. The `headword_links` table and its `panlex-fallback`
kind stay in the schema.

## CLI Maintenance

When modifying `drizzle/schema.ts`:

1. **New table** → Create `cli/commands/{table}.ts` and `cli/lib/formatters/{table}.ts`
2. **Columns changed** → Update formatters
3. **New relationships** → Add `--with-*` options

Run `/sync-cli` to check for gaps.

## Structure

```
cli/
├── index.ts           # Entry point, command registration
├── commands/          # Command implementations
│   ├── db.ts
│   ├── user.ts
│   ├── organization.ts
│   ├── workflow.ts
│   ├── operation.ts
│   └── import/        # Open-data dictionary importers
│       ├── index.ts
│       ├── wikidata-lexemes.ts
│       └── tatoeba.ts
└── lib/
    ├── output.ts      # Formatting utilities
    ├── types.ts       # Shared types
    ├── formatters/    # Entity-specific formatters
    └── importers/     # Importer contract, streaming, normalizing, upserts
```

## Adding Commands

See [.claude/rules/schema-changes.md](rules/schema-changes.md) for templates and checklist.
