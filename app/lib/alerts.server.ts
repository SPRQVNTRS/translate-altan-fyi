/**
 * Telling the operator that the spend guard did something, at most once a day.
 *
 * ONCE PER DAY PER KIND, AND THE DATABASE ENFORCES IT, NOT A FLAG IN MEMORY.
 *   The budget condition is true on every request after it is first met, so an
 *   alert raised straight from the condition fires for the rest of the day, and
 *   the one that matters next week is buried under it. A module-level "already
 *   sent" flag would not do: it resets on every deploy and every restart, and it
 *   is per process, so a second web container would send its own copy. The
 *   primary key on `alert_log(day, kind)` is the dedupe. The insert is the
 *   claim, and only the caller who actually inserted a row sends the message.
 *
 * AN ALERT TRANSPORT THAT THROWS MUST NEVER FAIL THE REQUEST THAT RAISED IT.
 *   The alert is a side channel about a request; the request itself is a reader
 *   asking for a dictionary entry. A webhook that is down, slow or misconfigured
 *   turning that into a 500 would mean the monitoring took the site off the air,
 *   which is the failure mode monitoring exists to prevent. Every send is
 *   therefore inside its own try/catch and its failure is a log line.
 *
 * THE TIMEOUT IS EXPLICIT, AND THAT IS NOT DECORATION.
 *   undici caps a non-streaming fetch at 300 seconds and surfaces the failure in
 *   the `json()` catch rather than the `fetch` catch. An unbounded call to a
 *   webhook that accepts the connection and then goes quiet would therefore hold
 *   a handler open for five minutes.
 */

import type { JsonObject } from '#app/lib/json';
import { createComponentLogger } from '#app/lib/logger';
import { alertLog } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';

const log = createComponentLogger('Alerts');

/** How long the webhook has to accept the message. */
const ALERT_WEBHOOK_TIMEOUT_MS = 5_000;

/** The two things worth waking an operator for. Matches the check constraint on `alert_log.kind`. */
export type AlertKind = 'budget-warning' | 'budget-cap';

/**
 * Raise one operator alert, at most once per UTC day per kind.
 *
 * @param params the kind, a sentence a human can act on, and the figures behind
 *   it. `detail` is a `JsonObject` because it is serialised straight into the
 *   webhook body and must therefore contain nothing that is not JSON.
 * @param at the instant whose UTC day the dedupe is keyed on.
 */
export async function raiseAlert(
  params: { kind: AlertKind; message: string; detail: JsonObject },
  at: Date = new Date(),
): Promise<void> {
  const db = getRawDb();
  const inserted = await db
    .insert(alertLog)
    .values({ day: at.toISOString().slice(0, 10), kind: params.kind })
    .onConflictDoNothing()
    .returning({ kind: alertLog.kind });

  // An empty result means a row already existed for this day and kind, so this
  // alert was already raised and there is nothing to send.
  if (inserted.length === 0) return;

  await sendAlert(params);
}

/**
 * Deliver the message, or log it when there is nowhere to deliver it.
 *
 * NO WEBHOOK IS AN ORDINARY STATE, NOT A FAULT. A development checkout and a
 * self-hosted install both run without one, and an alert that only exists as a
 * log line is still an alert. Throwing here would make the spend guard depend on
 * an integration the guard does not need.
 */
async function sendAlert(params: { kind: AlertKind; message: string; detail: JsonObject }): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL ?? '';
  if (url.length === 0) {
    log.warn(params.message, { kind: params.kind, detail: params.detail });
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: params.kind, message: params.message, detail: params.detail }),
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
    });
  } catch (cause) {
    // THE ROW IS ALREADY CLAIMED, so a failed send loses this alert for the rest
    // of the day. The message is therefore repeated into the error log, which is
    // the surface that survives a webhook outage. Retrying instead would need
    // the claim to be released, and a released claim is a claim two processes
    // can take, which is the duplicate storm the dedupe exists to stop.
    log.error('The alert webhook rejected the message', {
      kind: params.kind,
      message: params.message,
      detail: params.detail,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
