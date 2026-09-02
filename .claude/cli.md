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
│   └── operation.ts
└── lib/
    ├── output.ts      # Formatting utilities
    ├── types.ts       # Shared types
    └── formatters/    # Entity-specific formatters
```

## Adding Commands

See [.claude/rules/schema-changes.md](rules/schema-changes.md) for templates and checklist.
