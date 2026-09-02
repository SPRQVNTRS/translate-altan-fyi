---
name: cli-sync
description: Analyzes database schema and syncs CLI commands. Use when schema.ts changes, adding new tables, CLI is out of sync, or need to add CLI commands for entities.
---

# CLI Sync Skill

Ensures the CLI (`pnpm cli`) stays synchronized with the database schema.

## When to Use

- After modifying `drizzle/schema.ts`
- When adding a new database table
- When CLI commands are missing for an entity
- When column definitions change
- User asks to "sync CLI" or "update CLI"

## Analysis Steps

1. **Read current schema** - Parse `drizzle/schema.ts` for all tables
2. **Check existing CLI commands** - List files in `cli/commands/`
3. **Identify gaps** - Tables without corresponding CLI commands
4. **Check formatters** - Ensure `cli/lib/formatters/` has matching files

## Schema → CLI Mapping

| Schema | CLI Command | Formatter |
|--------|-------------|-----------|
| `users` table | `cli/commands/user.ts` | `cli/lib/formatters/user.ts` |
| `organizations` table | `cli/commands/organization.ts` | `cli/lib/formatters/organization.ts` |
| `workflows` table | `cli/commands/workflow.ts` | `cli/lib/formatters/workflow.ts` |
| `workflowOperations` table | `cli/commands/operation.ts` | `cli/lib/formatters/workflow.ts` |

## Creating New CLI Commands

### 1. Command File (`cli/commands/{entity}.ts`)

```typescript
import { Command } from 'commander';
import { db } from '#drizzle/db';
import { {tableName} } from '#drizzle/schema';
import { eq } from 'drizzle-orm';
import { output, outputJson, printError } from '../lib/output';
import { {entity}Columns, print{Entity}Detail } from '../lib/formatters/{entity}';
import type { OutputFormat } from '../lib/types';

export function register{Entity}Commands(program: Command): void {
  const cmd = program.command('{entity}').description('Manage {entities}');

  // List
  cmd.command('list')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '50')
    .action(async (options) => {
      const items = await db.query.{tableName}.findMany();
      output(options.format, items, {entity}Columns, {
        total: items.length,
        limit: parseInt(options.limit),
        offset: 0
      });
    });

  // Get by ID
  cmd.command('get <id>')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (id, options) => {
      const item = await db.query.{tableName}.findFirst({
        where: eq({tableName}.id, id)
      });
      if (!item) {
        printError(`{Entity} not found`);
        process.exitCode = 1;
        return;
      }
      if (options.format === 'json') {
        outputJson(item);
      } else {
        print{Entity}Detail(item);
      }
    });
}
```

### 2. Formatter File (`cli/lib/formatters/{entity}.ts`)

```typescript
import type { Select{Entity} } from '#drizzle/schema';
import type { TableColumn } from '../types';
import { printField, printSection, formatDate } from '../output';

export const {entity}Columns: TableColumn<Select{Entity}>[] = [
  { header: 'ID', key: 'id', width: 10 },
  // Add columns based on schema
];

export function print{Entity}Detail(item: Select{Entity}): void {
  printSection('{Entity} Details');
  printField('ID', item.id);
  // Add fields based on schema
}
```

### 3. Register in `cli/index.ts`

```typescript
import { register{Entity}Commands } from './commands/{entity}';
// ...
register{Entity}Commands(program);
```

### 4. Export from `cli/lib/formatters/index.ts`

```typescript
export * from './{entity}';
```

## Validation

After creating/updating CLI commands:

```bash
pnpm cli --help              # Command should appear
pnpm cli {entity} --help     # Subcommands should appear
pnpm cli {entity} list       # Should return data
```

## Special Considerations

- **Sensitive fields**: Sanitize passwords, tokens, secrets from JSON output
- **Relationships**: Add `--with-{relation}` flags for eager loading
- **Tenant-scoped tables**: May need `--org` filter option
- **Large tables**: Implement proper pagination with `--limit` and `--offset`
