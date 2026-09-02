import type { Route } from './+types/llm';
import { useState } from 'react';
import { Form, useNavigation } from 'react-router';
import { getFormProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';

import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#app/components/ui/table';
import { getUser } from '#app/middleware/helpers';
import {
  PROVIDERS,
  PROVIDER_IDS,
  type ActiveModelSelection,
  type OptionSupport,
  type ProviderId,
} from '#app/lib/llm/catalog';
import {
  LlmCapabilityError,
  LlmNotConfiguredError,
  registry,
} from '#app/lib/llm/registry.server';
import { getActiveModel, listActiveModelAudit, setActiveModel } from '#app/models/app-settings.server';

export const handle = {
  title: 'Language model',
};

// =============================================================================
// The active-model switch
// =============================================================================
// Superadmin only. The `_super` layout already runs `superadminMiddleware`, so
// this route neither re-checks the role nor exports a middleware of its own.
//
// THERE IS NO TEMPERATURE CONTROL, ON PURPOSE. Every catalog row marks
// temperature `unsupported`, because @sprqvntrs/llm 3.13.1 has no parameter to
// put one in. A slider here would set a value that never leaves the process,
// which is a lie told in a settings screen. When the client library grows the
// parameter, the catalog rows flip and a control can be added with the rest.
// =============================================================================

/** The model `<select>` value that means "I will type an identifier myself". */
const CUSTOM_MODEL_VALUE = '__custom__';

/** How many switches the history block shows. */
const AUDIT_LIMIT = 20;

/**
 * The switch form.
 *
 * `reasoningEffort` is optional rather than a union with the empty string:
 * Conform normalises an empty form value to `undefined` before the schema sees
 * it, so an `''` member would be unreachable. Absent therefore means "do not set
 * the option at all", which is the same thing the empty option in the select
 * says.
 */
const switchModelSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    model: z.string().min(1),
    customModel: z.string().optional(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.model !== CUSTOM_MODEL_VALUE) return;
    if (value.customModel !== undefined && value.customModel.length > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['customModel'],
      message: 'Enter a model identifier.',
    });
  });

export async function loader() {
  const active = await getActiveModel();
  const status = registry.describeConfiguration(active);
  const audit = await listActiveModelAudit(AUDIT_LIMIT);

  // The catalog crosses to the client so the two dependent selects can react to
  // a provider change without a round trip. It is plain data with no key values
  // in it, and `describeConfiguration` returns only a reason string, so nothing
  // secret rides along.
  return { active, status, audit, providers: PROVIDERS };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = getUser(context);
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: switchModelSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply(), switchedTo: null };
  }

  const { provider, model, customModel, reasoningEffort } = submission.value;
  const resolvedModel = model === CUSTOM_MODEL_VALUE ? (customModel ?? '') : model;
  const candidate = {
    provider,
    model: resolvedModel,
    options: reasoningEffort === undefined ? {} : { reasoningEffort },
  } satisfies ActiveModelSelection;

  // WHY THE TWO ERRORS ARE TREATED DIFFERENTLY, which is the whole point of this
  // page. A capability error is the reason the check runs BEFORE the write: an
  // option the provider cannot express must be refused here, because accepting
  // it would mean the registry silently drops it at call time and the operator
  // never learns the setting did nothing.
  //
  // A missing key is not that. It says the environment is behind the decision,
  // not that the decision is wrong, and an operator must be able to select a
  // provider before its key is deployed. `configureActiveModel` checks
  // capabilities first and the key last, so catching `LlmNotConfiguredError` and
  // carrying on still gets the full capability verdict. The page then shows the
  // absent key as a warning on the next render.
  try {
    registry.configureActiveModel(candidate);
  } catch (cause) {
    if (cause instanceof LlmCapabilityError) {
      return {
        result: submission.reply({ formErrors: [`Switch refused because ${cause.message}.`] }),
        switchedTo: null,
      };
    }
    if (!(cause instanceof LlmNotConfiguredError)) throw cause;
  }

  await setActiveModel({
    next: candidate,
    actorUserId: String(user.id),
    actorEmail: user.email,
  });

  return { result: submission.reply(), switchedTo: candidate.model };
}

const CARD_CLASS = 'rounded-lg border bg-card p-4 shadow-sm';
const SECTION_LABEL_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-primary';
const CONTROL_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * What to say under the reasoning-effort select, per level of end-to-end
 * support. A table rather than a chain of comparisons: no catalog row is
 * `unsupported` today, so comparing against it would be dead code the compiler
 * rejects, while the row below simply waits for the day a provider needs it.
 */
const REASONING_EFFORT_NOTE = {
  supported: null,
  none: 'honours only "none". A graded level would change nothing.',
  unsupported: 'cannot be sent this option on its transport.',
} satisfies Record<OptionSupport, string | null>;

/** One side of an audit row, as the history table prints it. */
function describeSelection(selection: ActiveModelSelection | null): string {
  if (selection === null) return '-';
  return `${selection.provider} / ${selection.model}`;
}

export default function SuperLlm({ loaderData, actionData }: Route.ComponentProps) {
  const { active, status, audit, providers } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== 'idle';

  const activeEntry = providers[active.provider];
  const activeIsCatalogued = activeEntry.models.some((entry) => entry.id === active.model);

  const [providerId, setProviderId] = useState<ProviderId>(active.provider);
  const [modelValue, setModelValue] = useState(activeIsCatalogued ? active.model : CUSTOM_MODEL_VALUE);
  const [customModel, setCustomModel] = useState(activeIsCatalogued ? '' : active.model);

  const selectedEntry = providers[providerId];
  const reasoningNote = REASONING_EFFORT_NOTE[selectedEntry.capabilities.reasoningEffort];

  const [form, fields] = useForm({
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: switchModelSchema });
    },
    shouldValidate: 'onBlur',
  });

  /**
   * Moving to another provider retargets both dependent selects in the same
   * event, so the form can never post a model belonging to the provider the
   * operator just left.
   */
  function selectProvider(nextProviderId: ProviderId): void {
    const nextEntry = providers[nextProviderId];
    setProviderId(nextProviderId);
    setModelValue(nextEntry.models[0]?.id ?? CUSTOM_MODEL_VALUE);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Language model</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the model and provider used to write dictionary explanations.
        </p>
      </div>

      <section className={CARD_CLASS}>
        <h2 className={SECTION_LABEL_CLASS}>Current model</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted-foreground">Provider</dt>
            <dd className="font-medium">{activeEntry.label}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted-foreground">Model</dt>
            <dd className="font-mono">{active.model}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted-foreground">Reasoning effort</dt>
            <dd>{active.options.reasoningEffort ?? 'Provider default'}</dd>
          </div>
        </dl>

        {status.configured && <p className="mt-3 text-sm text-muted-foreground">API key is present.</p>}
        {!status.configured && (
          <div className="mt-3 space-y-1">
            <p className="text-sm font-medium text-destructive">
              {`The environment variable ${activeEntry.apiKeyEnvVar} is missing. Generations will fail.`}
            </p>
            <p className="text-sm text-muted-foreground">{status.reason}</p>
          </div>
        )}

        {activeEntry.note !== null && (
          <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">{activeEntry.note}</p>
        )}
      </section>

      <section className={CARD_CLASS}>
        <Form method="post" {...getFormProps(form)} className="space-y-4">
          {form.errors && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {form.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}

          {actionData?.switchedTo !== undefined && actionData.switchedTo !== null && (
            <p className="rounded-md bg-primary/10 p-3 text-sm text-primary">
              {`Active model updated to ${actionData.switchedTo}.`}
            </p>
          )}

          <div className="grid gap-2">
            <Label htmlFor={fields.provider.id}>Provider</Label>
            <select
              id={fields.provider.id}
              name={fields.provider.name}
              className={CONTROL_CLASS}
              value={providerId}
              onChange={(event) => {
                const next = z.enum(PROVIDER_IDS).safeParse(event.target.value);
                if (next.success) selectProvider(next.data);
              }}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {providers[id].label}
                </option>
              ))}
            </select>
            {fields.provider.errors && <p className="text-sm text-destructive">{fields.provider.errors}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={fields.model.id}>Model</Label>
            <select
              id={fields.model.id}
              name={fields.model.name}
              className={CONTROL_CLASS}
              value={modelValue}
              onChange={(event) => setModelValue(event.target.value)}
            >
              {selectedEntry.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              <option value={CUSTOM_MODEL_VALUE}>Other...</option>
            </select>
            {fields.model.errors && <p className="text-sm text-destructive">{fields.model.errors}</p>}
          </div>

          {modelValue === CUSTOM_MODEL_VALUE && (
            <div className="grid gap-2">
              <Label htmlFor={fields.customModel.id}>Model identifier</Label>
              <Input
                id={fields.customModel.id}
                name={fields.customModel.name}
                type="text"
                className="font-mono"
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Enter a model identifier if it is not in the list.
              </p>
              {fields.customModel.errors && (
                <p className="text-sm text-destructive">{fields.customModel.errors}</p>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor={fields.reasoningEffort.id}>Reasoning effort</Label>
            <select
              id={fields.reasoningEffort.id}
              name={fields.reasoningEffort.name}
              className={CONTROL_CLASS}
              defaultValue={active.options.reasoningEffort ?? ''}
            >
              <option value="">Provider default</option>
              <option value="none">none</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <p className="text-sm text-muted-foreground">
              The switch is refused if the selected provider cannot support this option.
            </p>
            {reasoningNote !== null && (
              <p className="text-sm text-muted-foreground">{`${selectedEntry.label} ${reasoningNote}`}</p>
            )}
            {fields.reasoningEffort.errors && (
              <p className="text-sm text-destructive">{fields.reasoningEffort.errors}</p>
            )}
          </div>

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
            {isSubmitting ? 'Switching model' : 'Switch model'}
          </Button>
        </Form>
      </section>

      <section className={CARD_CLASS}>
        <h2 className={SECTION_LABEL_CLASS}>Recent switches</h2>
        {audit.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No switches recorded.</p>}
        {audit.length > 0 && (
          <div className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="tabular-nums">{new Date(entry.at).toLocaleString()}</TableCell>
                    <TableCell>{entry.actorEmail ?? entry.actorUserId ?? 'System process'}</TableCell>
                    <TableCell className="font-mono">{describeSelection(entry.before)}</TableCell>
                    <TableCell className="font-mono">{describeSelection(entry.after)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
