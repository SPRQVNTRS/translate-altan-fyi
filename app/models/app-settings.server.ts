import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';

import { db } from '#drizzle/db';
import { appSettings, appSettingsAudit } from '#drizzle/schema';
import { createComponentLogger } from '#app/lib/logger';
import { ACTIVE_MODEL_SETTING_KEY, DEFAULT_ACTIVE_MODEL, PROVIDER_IDS } from '#app/lib/llm/catalog';

const logger = createComponentLogger('AppSettings');

/**
 * The stored shape of `llm.active`.
 *
 * `strictObject` on both levels is deliberate. The value comes out of a JSONB
 * column that anything with database access can write, and an unexpected key is
 * far more likely to be a stale option name from an older revision than a
 * harmless extra. Rejecting it makes the row fall back to the default loudly,
 * in the log, instead of running with an option the registry will never read.
 */
export const activeModelSchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().min(1),
  options: z
    .strictObject({
      temperature: z.number().optional(),
      reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
    })
    .default({}),
});

export type ActiveModel = z.infer<typeof activeModelSchema>;

/** One change to `llm.active`, as the admin page renders it. */
export interface AuditEntryView {
  id: string;
  before: ActiveModel | null;
  after: ActiveModel | null;
  actorUserId: string | null;
  actorEmail: string | null;
  at: Date;
}

/**
 * Read the active model.
 *
 * READ PER JOB, NEVER CACHED AT MODULE LOAD. Switching the model is an operator
 * action taken while the worker is running, and a module-level cache would make
 * it take effect only after a restart, which is exactly the thing this setting
 * exists to avoid.
 *
 * @returns the stored model, or `DEFAULT_ACTIVE_MODEL` when the row is absent or
 *   fails to parse. It never throws: a broken settings row must not stop the
 *   enrichment workflow, it must degrade it to the default and say so in the log.
 */
export async function getActiveModel(): Promise<ActiveModel> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, ACTIVE_MODEL_SETTING_KEY)).limit(1);
  if (!row) return activeModelSchema.parse(DEFAULT_ACTIVE_MODEL);
  const parsed = activeModelSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.error('Stored active model is unreadable, falling back to the default', {
      key: ACTIVE_MODEL_SETTING_KEY,
      issues: z.prettifyError(parsed.error),
      fallback: DEFAULT_ACTIVE_MODEL,
    });
    return activeModelSchema.parse(DEFAULT_ACTIVE_MODEL);
  }
  return parsed.data;
}

/**
 * Alias of {@link getActiveModel}, for call sites that read better as "load".
 * There is one implementation on purpose: two would drift.
 */
export const loadActiveModel = getActiveModel;

export interface SetActiveModelParams {
  next: ActiveModel;
  actorUserId: string | null;
  actorEmail: string | null;
}

/**
 * Write the active model and record the change.
 *
 * The upsert and the audit row go in ONE transaction, so a change that cannot be
 * attributed does not land at all. Splitting them would let the setting move
 * with no history behind it, which is the failure the audit table exists to
 * prevent.
 *
 * @param params - the new value plus the actor, either of which may be null when
 *   a migration or a CLI writes the setting.
 * @returns the value that was written.
 */
export async function setActiveModel(params: SetActiveModelParams): Promise<ActiveModel> {
  const next = activeModelSchema.parse(params.next);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, ACTIVE_MODEL_SETTING_KEY))
      .limit(1);
    const [written] = await tx
      .insert(appSettings)
      .values({
        key: ACTIVE_MODEL_SETTING_KEY,
        value: next,
        updatedBy: params.actorUserId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: next, updatedBy: params.actorUserId, updatedAt: new Date() },
      })
      .returning();
    if (!written) throw new Error('Failed to write the active model setting');
    await tx.insert(appSettingsAudit).values({
      key: ACTIVE_MODEL_SETTING_KEY,
      before: existing?.value ?? null,
      after: next,
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
    });
    return next;
  });
}

/**
 * The recent history of `llm.active`, newest first.
 *
 * Rows whose stored value no longer parses are returned with a null `before` or
 * `after` rather than dropped. A history that silently hides the changes it
 * cannot read is worse than one that shows a gap.
 *
 * @param limit - how many changes to return. Defaults to 20.
 */
export async function listActiveModelAudit(limit = 20): Promise<AuditEntryView[]> {
  const rows = await db
    .select()
    .from(appSettingsAudit)
    .where(eq(appSettingsAudit.key, ACTIVE_MODEL_SETTING_KEY))
    .orderBy(desc(appSettingsAudit.at))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    before: parseAuditValue(row.before),
    after: parseAuditValue(row.after),
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    at: row.at,
  }));
}

/** Decode one side of an audit row, tolerating a shape an older revision wrote. */
function parseAuditValue(value: SelectAuditValue): ActiveModel | null {
  if (value === null || value === undefined) return null;
  const parsed = activeModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The JSONB column type of `app_settings_audit.before` / `.after`, as Drizzle returns it. */
type SelectAuditValue = (typeof appSettingsAudit.$inferSelect)['before'];
