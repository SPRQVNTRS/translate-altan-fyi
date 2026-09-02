# Workflow Orchestrator Guide

This project uses a pg-boss-backed workflow orchestration system for background job processing.

## Architecture

```
WorkflowOrchestrator (Public API)
         │
         ▼
  ExecutionEngine (Stage/operation processing)
         │
    ┌────┼────┐
    ▼    ▼    ▼
Templates  Operations  Database
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Workflow** | Complete unit of work, progresses through stages |
| **Stage** | Logical grouping of operations (sequential) |
| **Operation** | Smallest unit, single responsibility, idempotent |
| **Template** | Declarative workflow definition |

## Directory Structure

```
app/workflows/
├── index.ts           # Public API: registerAllWorkflows()
├── types.ts           # Types and WORKFLOW_TYPES constants
├── templates/         # Workflow definitions
│   ├── index.ts       # Template registry
│   └── *.ts           # Individual templates
└── operations/        # Handler implementations
    ├── index.ts       # Handler registry (operationHandlers)
    └── {domain}/      # Domain-specific handlers
```

## Creating a Workflow

### 1. Define Template

```typescript
// app/workflows/templates/my-workflow.ts
import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';

export const myWorkflowTemplate: WorkflowTemplateWithHandlers = {
  type: 'my-workflow',
  queue: 'default',
  version: '1.0.0',
  description: 'What this workflow does',
  estimatedDurationSeconds: 30,
  stages: [
    {
      name: 'stage-name',
      operations: [
        {
          type: 'my.operation',
          handler: operationHandlers.my.operation,
          timeout: 30000,
          maxAttempts: 3,
          critical: true,
        },
      ],
    },
  ],
};
```

### 2. Implement Handler

```typescript
// app/workflows/operations/my/operation.ts
import type { OperationHandler } from '@sprqvntrs/workflows';

export const myOperationHandler: OperationHandler = async (ctx) => {
  // ctx.workflowId, ctx.operationId, ctx.initialContext
  try {
    return { status: 'completed', data: { /* output */ } };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
};
```

### 3. Register Handler

```typescript
// app/workflows/operations/index.ts
export const operationHandlers = {
  my: { operation: myOperationHandler },
} as const;
```

### 4. Register Template

```typescript
// app/workflows/templates/index.ts
export const workflowTemplates = [..., myWorkflowTemplate];
export { myWorkflowTemplate };
```

## Database Operations

Workflows run outside the HTTP context, so there's no middleware to set tenant info. Pull `organizationId` from the workflow's initial context and pass it to `tenantDb(ctx)`:

```typescript
import { tenantDb } from '#drizzle/tenant-db';
import { articles } from '#drizzle/schema';

export const myHandler: OperationHandler = async (ctx) => {
  const input = ctx.initialContext as { organizationId: string; authorId: number };

  const [result] = await tenantDb({ orgId: input.organizationId })
    .insert(articles, { title, slug, content, authorId: input.authorId })
    .returning();
};
```

## Context Types

Define in `app/workflows/types.ts`:

```typescript
export interface MyWorkflowContext {
  param1: string;
  organizationId: string;  // Required for tenant-scoped data
}
```

## Reference

- Tenant-safe DB skill: [.claude/skills/tenant-safe-db/SKILL.md](skills/tenant-safe-db/SKILL.md)
- Example: [app/workflows/templates/dummy-workflow.ts](../app/workflows/templates/dummy-workflow.ts)
