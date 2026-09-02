import type { Route } from './+types/workflows';
import { Form, useNavigation, useRevalidator } from 'react-router';
import { useEffect } from 'react';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getRawDb } from '#drizzle/tenant-db';
import { workflows as workflowsTable } from '#drizzle/schema';
import { getOrchestrator } from '#app/services/workflows.server';
import { getTenant } from '#app/middleware/tenant';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';
import { Button } from '#app/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#app/components/ui/card';
import { Badge } from '#app/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#app/components/ui/table';
import { ConfirmAction } from '#app/components/confirm-action';
import {
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
  Workflow,
  Ban,
  Trash2,
} from 'lucide-react';
import { getUser } from '#app/middleware/helpers';
import { z } from 'zod';

export { RouteErrorBoundary as ErrorBoundary };

// Type for workflow records returned from the orchestrator
interface WorkflowRecord {
  id: string;
  type: string;
  status: string;
  currentStage: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export const handle = {
  title: 'Workflows',
};

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = getTenant(context);
  const organizationId = tenant.orgId;

  // Workflow tables come from @sprqvntrs/workflows and have no organizationId column.
  // Tenant scope lives in the `context` JSONB the orchestrator stores per workflow.
  const orgFilter = sql`${workflowsTable.context}->>'organizationId' = ${organizationId}`;

  const workflowList = await getRawDb().query.workflows.findMany({
    where: orgFilter,
    orderBy: [desc(workflowsTable.createdAt)],
    limit: 50,
  });

  // Count workflows by status
  const statusCounts = workflowList.reduce(
    (acc: Record<string, number>, w: { status: string }) => {
      acc[w.status] = (acc[w.status] || 0) + 1;
      return acc;
    },
    {},
  );

  return { workflows: workflowList, statusCounts, organizationId };
}

export async function action({ request, context }: Route.ActionArgs) {
  const tenant = getTenant(context);
  const _user = getUser(context); // ensure auth context; user id not needed here
  void _user;
  const organizationId = tenant.orgId;
  const formData = await request.formData();
  const intent = formData.get('intent');

  const orchestrator = getOrchestrator();

  // Same JSONB filter the loader uses — every purge is scoped to this org.
  const orgFilter = sql`${workflowsTable.context}->>'organizationId' = ${organizationId}`;
  const db = getRawDb();
  const purgeByStatus = (status: string) =>
    db.delete(workflowsTable).where(and(eq(workflowsTable.status, status), orgFilter));

  switch (intent) {
    case 'trigger': {
      const message =
        z.string().min(1).catch('Triggered from workflows page').parse(formData.get('message'));
      const { workflowId, jobId } = await orchestrator.start({
        type: 'dummy-workflow',
        context: {
          message,
          triggeredAt: new Date().toISOString(),
          organizationId,
        },
      });
      return { success: true, workflowId, jobId };
    }

    case 'cancel': {
      const workflowId = z.string().parse(formData.get('workflowId'));
      await orchestrator.cancel(workflowId);
      return { success: true, cancelled: workflowId };
    }

    case 'retry': {
      const workflowId = z.string().parse(formData.get('workflowId'));
      const jobId = await orchestrator.retry(workflowId);
      return { success: true, retried: workflowId, jobId };
    }

    case 'purge-pending': {
      const result = await purgeByStatus('pending');
      return { success: true, message: `${result.rowCount ?? 0} pending workflows purged` };
    }

    case 'purge-completed': {
      const result = await purgeByStatus('completed');
      return { success: true, message: `${result.rowCount ?? 0} completed workflows purged` };
    }

    case 'purge-failed': {
      const result = await purgeByStatus('failed');
      return { success: true, message: `${result.rowCount ?? 0} failed workflows purged` };
    }

    case 'purge-cancelled': {
      const result = await purgeByStatus('cancelled');
      return { success: true, message: `${result.rowCount ?? 0} cancelled workflows purged` };
    }

    default:
      return { error: 'Unknown action' };
  }
}

const workflowStatusSchema = z.enum([
  'pending',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

const statusConfig = {
  pending: { label: 'Pending', icon: Clock, variant: 'outline' },
  active: { label: 'Active', icon: Loader2, variant: 'default' },
  paused: { label: 'Paused', icon: AlertCircle, variant: 'secondary' },
  completed: { label: 'Completed', icon: CheckCircle, variant: 'outline' },
  failed: { label: 'Failed', icon: XCircle, variant: 'destructive' },
  cancelled: { label: 'Cancelled', icon: Ban, variant: 'secondary' },
} satisfies Record<WorkflowStatus, { label: string; icon: typeof CheckCircle; variant: BadgeVariant }>;

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

/** The badge for a workflow status, falling back to `pending` for unknown values. */
function statusFor(status: string) {
  const known = workflowStatusSchema.safeParse(status);
  return known.success ? statusConfig[known.data] : statusConfig.pending;
}

function StatusBadge({ status }: { status: string }) {
  const config = statusFor(status);
  const Icon = config.icon;
  const isSpinning = status === 'active';

  return (
    <Badge variant={config.variant}>
      <Icon className={`h-3 w-3 ${isSpinning ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}

export default function OrgWorkflows({ loaderData }: Route.ComponentProps) {
  const { workflows, statusCounts } = loaderData;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isTriggering =
    navigation.state === 'submitting' && navigation.formData?.get('intent') === 'trigger';

  // Auto-refresh when there are active workflows
  const hasActiveWorkflows = workflows.some((w: WorkflowRecord) => w.status === 'active' || w.status === 'pending');

  useEffect(() => {
    if (!hasActiveWorkflows) return;

    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 3000);

    return () => clearInterval(interval);
  }, [hasActiveWorkflows, revalidator]);

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <div className="bg-card rounded-lg shadow-sm p-6 border">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Workflows</h1>
            <p className="text-muted-foreground">Manage and monitor workflow executions</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Workflow className="h-5 w-5" />
              <span className="text-sm font-medium">{workflows.length} workflows</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state === 'loading'}
            >
              <RefreshCw className={`h-4 w-4 ${revalidator.state === 'loading' ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Trigger Dummy Workflow Card */}
      <Card>
        <CardHeader>
          <CardTitle>Trigger Test Workflow</CardTitle>
          <CardDescription>
            Start a new instance of the demonstration workflow. This workflow simulates a 3-stage
            process: initialization, data processing, and report generation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="flex items-end gap-4">
            <input type="hidden" name="intent" value="trigger" />
            <div className="flex-1">
              <label htmlFor="message" className="text-sm font-medium mb-2 block">
                Message (optional)
              </label>
              <input
                type="text"
                id="message"
                name="message"
                placeholder="Enter a custom message for the workflow..."
                className="w-full px-3 py-2 border rounded-md bg-background"
              />
            </div>
            <Button type="submit" disabled={isTriggering}>
              {isTriggering ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isTriggering ? 'Starting...' : 'Start Workflow'}
            </Button>
          </Form>
        </CardContent>
      </Card>

      {/* Workflow Management */}
      <Card>
        <CardHeader>
          <CardTitle>Workflow Management</CardTitle>
          <CardDescription>Cleanup and manage workflow records</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {/* Purge Pending */}
            <ConfirmAction
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(statusCounts['pending'] || 0) === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Purge Pending
                  {(statusCounts['pending'] || 0) > 0 && (
                    <Badge variant="secondary" className="ml-1">
                      {statusCounts['pending']}
                    </Badge>
                  )}
                </Button>
              }
              title="Purge Pending Workflows"
              description="This will permanently delete all pending workflow records. This action cannot be undone."
              formData={{ intent: 'purge-pending' }}
              confirmText="Delete All"
              confirmVariant="destructive"
            />

            {/* Purge Completed */}
            <ConfirmAction
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(statusCounts['completed'] || 0) === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Purge Completed
                  {(statusCounts['completed'] || 0) > 0 && (
                    <Badge variant="secondary" className="ml-1">
                      {statusCounts['completed']}
                    </Badge>
                  )}
                </Button>
              }
              title="Purge Completed Workflows"
              description="This will permanently delete all completed workflow records. This action cannot be undone."
              formData={{ intent: 'purge-completed' }}
              confirmText="Delete All"
              confirmVariant="destructive"
            />

            {/* Purge Failed */}
            <ConfirmAction
              trigger={
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={(statusCounts['failed'] || 0) === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Purge Failed
                  {(statusCounts['failed'] || 0) > 0 && (
                    <Badge variant="secondary" className="ml-1">
                      {statusCounts['failed']}
                    </Badge>
                  )}
                </Button>
              }
              title="Purge Failed Workflows"
              description="This will permanently delete all failed workflow records. This action cannot be undone."
              formData={{ intent: 'purge-failed' }}
              confirmText="Delete All"
              confirmVariant="destructive"
            />

            {/* Purge Cancelled */}
            <ConfirmAction
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(statusCounts['cancelled'] || 0) === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Purge Cancelled
                  {(statusCounts['cancelled'] || 0) > 0 && (
                    <Badge variant="secondary" className="ml-1">
                      {statusCounts['cancelled']}
                    </Badge>
                  )}
                </Button>
              }
              title="Purge Cancelled Workflows"
              description="This will permanently delete all cancelled workflow records. This action cannot be undone."
              formData={{ intent: 'purge-cancelled' }}
              confirmText="Delete All"
              confirmVariant="destructive"
            />
          </div>
        </CardContent>
      </Card>

      {/* Workflows Table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Workflows</CardTitle>
          <CardDescription>
            View and manage workflow executions
            {hasActiveWorkflows && (
              <span className="ml-2 text-blue-500">(auto-refreshing)</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {workflows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Workflow className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No workflows yet. Trigger your first workflow above!</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="w-[150px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((workflow: WorkflowRecord) => (
                  <TableRow key={workflow.id}>
                    <TableCell className="font-mono text-xs">
                      {workflow.id.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="font-medium">
                      {workflow.type}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={workflow.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {workflow.currentStage || '-'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(workflow.createdAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {workflow.completedAt
                        ? new Date(workflow.completedAt).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {(workflow.status === 'active' || workflow.status === 'pending') && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="cancel" />
                            <input type="hidden" name="workflowId" value={workflow.id} />
                            <Button variant="ghost" size="sm" type="submit">
                              <Ban className="h-4 w-4" />
                              <span className="sr-only">Cancel</span>
                            </Button>
                          </Form>
                        )}
                        {workflow.status === 'failed' && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="retry" />
                            <input type="hidden" name="workflowId" value={workflow.id} />
                            <Button variant="ghost" size="sm" type="submit">
                              <RefreshCw className="h-4 w-4" />
                              <span className="sr-only">Retry</span>
                            </Button>
                          </Form>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Error Display */}
      {workflows.some((w: WorkflowRecord) => w.status === 'failed' && w.errorMessage) && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Failed Workflows</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {workflows
              .filter((w: WorkflowRecord) => w.status === 'failed' && w.errorMessage)
              .map((w: WorkflowRecord) => (
                <div key={w.id} className="p-4 bg-destructive/10 rounded-md">
                  <p className="font-mono text-sm mb-1">{w.id.slice(0, 8)}...</p>
                  <p className="text-sm text-destructive">{w.errorMessage}</p>
                </div>
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
