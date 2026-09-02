---
description: Analyze schema and sync CLI commands. Run after schema changes.
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(pnpm cli:*)
---

# Sync CLI with Schema

Analyze the database schema and ensure CLI commands are up to date.

## Current Schema

@drizzle/schema.ts

## Current CLI Commands

!`ls -la cli/commands/`

## Current Formatters

!`ls -la cli/lib/formatters/`

## Your Task

1. **Analyze the schema** - Identify all tables defined in `drizzle/schema.ts`

2. **Check CLI coverage** - For each table, verify:
   - Command file exists in `cli/commands/`
   - Formatter exists in `cli/lib/formatters/`
   - Command is registered in `cli/index.ts`

3. **Report gaps** - List any tables without CLI support

4. **Generate missing commands** - If tables are missing CLI commands:
   - Create the command file following existing patterns
   - Create the formatter file
   - Register in index.ts
   - Export from formatters/index.ts

5. **Validate** - Run `pnpm cli --help` to verify

## Expected Tables → CLI Mapping

| Table | Command | Status |
|-------|---------|--------|
| users | `pnpm cli user` | ? |
| organizations | `pnpm cli org` | ? |
| organizationMembers | (part of org) | ? |
| articles | `pnpm cli article` | ? |
| categories | `pnpm cli category` | ? |
| pages | `pnpm cli page` | ? |
| workflows | `pnpm cli workflow` | ? |
| workflowOperations | `pnpm cli operation` | ? |
| workflowLocks | (part of workflow) | ? |

Fill in the Status column and create any missing commands.
