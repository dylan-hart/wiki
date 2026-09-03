import http from 'node:http'
import https from 'node:https'
import { hooks as hooksTable, jobHistory as jobHistoryTable } from '../db/schema.ts'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { durationToSeconds } from '../helpers/common.ts'
import { paginate } from '../helpers/pagination.ts'
import type { JobState } from './jobs.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

/**
 * The events a webhook can subscribe to, as offered by the admin area.
 *
 * See {@link EMITTED_EVENTS} for which of these something in the server actually fires today.
 */
export const HOOK_EVENTS = [
  'page:create',
  'page:edit',
  'page:rename',
  'page:delete',
  'asset:upload',
  'asset:edit',
  'asset:rename',
  'asset:delete',
  'asset:move',
  'comment:new',
  'comment:edit',
  'comment:delete',
  'user:join',
  'user:login',
  'user:logout',
  'approval:submitted',
  'approval:approved',
  'approval:rejected',
  'page:classification-changed'
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * The events something in the server actually emits today.
 *
 * Kept as an explicit list rather than inferred from the prefix, since a new entry in
 * {@link HOOK_EVENTS} does not necessarily have an `emit()` call wired up yet. Add an event here when
 * you add its `emit()` call.
 *
 * `comment:*`'s `emit()` calls live in `models/comments.ts`'s `create`/`update`/`delete`, matching
 * `page:*`/`asset:*` (OpenProject #1923 moved these out of `api/comments.ts`, the one route-layer
 * exception to that convention).
 */
export const EMITTED_EVENTS: HookEvent[] = [
  'page:create',
  'page:edit',
  'page:rename',
  'page:delete',
  'asset:upload',
  'asset:edit',
  'asset:rename',
  'asset:delete',
  'asset:move',
  'comment:new',
  'comment:edit',
  'comment:delete',
  'user:join',
  'user:login',
  'user:logout',
  'approval:submitted',
  'approval:approved',
  'approval:rejected',
  'page:classification-changed'
]

/** A webhook as exposed by the API. */
export type Hook = typeof hooksTable.$inferSelect

/** One recorded attempt to deliver an event to a webhook. */
export interface HookDelivery {
  event: string
  state: JobState
  attempt: number
  maxRetries: number
  lastErrorMessage: string | null
  startedAt: Date
  completedAt: Date | null
}

/** One page of a webhook's delivery history, with the total matching the filter. */
export interface HookDeliveryPage {
  total: number
  deliveries: HookDelivery[]
}

/** How long a remote endpoint has to answer before the delivery counts as failed. */
const DELIVERY_TIMEOUT = 15000

/**
 * Defaults for the per-webhook delivery rate limit, used until an operator configures their own and
 * whenever a stored value is missing or unusable. Sixty a minute is far more than any of the events
 * this fires on legitimately produces in a burst, and is what stands between one busy hook and either
 * the remote endpoint or the shared job queue being flooded by it.
 */
const WEBHOOK_RATE_LIMIT_DEFAULTS: RateLimitPolicy = {
  max: 60,
  windowSeconds: 60,
  banSeconds: 60
}

/**
 * The configured policy for `emit()`'s per-hook rate limit.
 *
 * Same fallback shape as `helpers/rateLimit.ts#authPolicy()`: every field falls back on its own, and
 * the two durations are stored as an operator wrote them (`1m`, `5m`) rather than as raw seconds.
 */
function webhookRateLimitPolicy(): RateLimitPolicy {
  const scheduler = WIKI.config.scheduler ?? {}
  const max = Number(scheduler.webhookRateLimitMax)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : WEBHOOK_RATE_LIMIT_DEFAULTS.max,
    windowSeconds: durationToSeconds(
      scheduler.webhookRateLimitWindow,
      WEBHOOK_RATE_LIMIT_DEFAULTS.windowSeconds
    ),
    banSeconds: durationToSeconds(
      scheduler.webhookRateLimitBan,
      WEBHOOK_RATE_LIMIT_DEFAULTS.banSeconds
    )
  }
}

/**
 * POST a JSON body, with control over certificate validation.
 *
 * `node:https` rather than `fetch`: a webhook may legitimately point at an endpoint with a
 * self-signed certificate, and per-request TLS options are not expressible through fetch.
 *
 * Exported so `api/hooks.ts` can reuse it for `POST /hooks/test` — a synthetic delivery to a URL
 * that need not belong to any saved webhook (or even be valid yet), so it has no `hookId` to look up
 * and must not go through `deliver()`, which reads and writes a persisted hook's state.
 */
export function postJson(
  url: string,
  body: string,
  { authHeader, acceptUntrusted }: { authHeader?: string | null; acceptUntrusted: boolean }
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`"${url}" is not a valid URL.`))
      return
    }
    const transport = target.protocol === 'http:' ? http : https

    const req = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': `Wiki.js/${WIKI.version}`,
          ...(authHeader ? { authorization: authHeader } : {})
        },
        timeout: DELIVERY_TIMEOUT,
        ...(target.protocol === 'https:' && acceptUntrusted ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        // -> The body is irrelevant, but it has to be drained for the socket to be released
        res.resume()
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }))
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`The endpoint did not respond within ${DELIVERY_TIMEOUT / 1000}s.`))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Hooks model
 *
 * Webhooks POST a JSON body to a remote endpoint when something happens. Delivery goes through the
 * scheduler rather than the request that triggered it: a slow or broken endpoint must not delay a
 * user's action, and the scheduler already provides retries and a place to see failures.
 */
class Hooks {
  /**
   * Every webhook, newest first
   */
  async getHooks(): Promise<Hook[]> {
    const results = await WIKI.db.select().from(hooksTable).orderBy(desc(hooksTable.createdAt))
    return results
  }

  /**
   * A single webhook, or null if there is no such webhook
   */
  async getHookById(id: string): Promise<Hook | null> {
    const results = await WIKI.db.select().from(hooksTable).where(eq(hooksTable.id, id)).limit(1)
    return results[0] ?? null
  }

  /**
   * A webhook's delivery history, most recently started first.
   *
   * Backed by `jobHistory` — `deliver()` runs as the `dispatchWebhook` task and every attempt is
   * already recorded there, so this reads that log rather than keeping a second one. Paginated the
   * same way `models/jobs.ts#getHistory()` paginates: `total` counts every matching row, `deliveries`
   * is capped at `limit`, so a caller can tell it is looking at a truncated view.
   *
   * Retention is `jobHistory`'s own — `scheduler.historyExpiration` (~25h by default), purged by the
   * same `cleanJobHistory` task as every other job. Deliberately not given its own longer-lived
   * retention: the durable signal for "is this webhook healthy" is `hooks.state` /
   * `hooks.lastErrorMessage`, which this table has nothing to do with and which never expires. This
   * history is recent-attempts diagnostics on top of that — a window onto the last day or so of
   * retries — not an audit log, so the shared retention is the right default. A longer-lived history
   * would need its own config knob and cleanup path (not a reason to duplicate this table); revisit
   * if that diagnostic window in practice proves too short.
   *
   * @param hookId Which webhook's deliveries to return
   * @param limit Caps the rows returned
   */
  async getDeliveryHistory(
    hookId: string,
    { limit = 100 }: { limit?: number } = {}
  ): Promise<HookDeliveryPage> {
    const where = and(
      eq(jobHistoryTable.task, 'dispatchWebhook'),
      sql`${jobHistoryTable.payload} ->> 'hookId' = ${hookId}`
    )
    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select({
            event: sql<string>`${jobHistoryTable.payload} ->> 'event'`,
            state: jobHistoryTable.state,
            attempt: jobHistoryTable.attempt,
            maxRetries: jobHistoryTable.maxRetries,
            lastErrorMessage: jobHistoryTable.lastErrorMessage,
            startedAt: jobHistoryTable.startedAt,
            completedAt: jobHistoryTable.completedAt
          })
          .from(jobHistoryTable)
          .where(where)
          .orderBy(desc(jobHistoryTable.startedAt))
          .limit(limit),
      total: () => WIKI.db.select({ total: count() }).from(jobHistoryTable).where(where)
    })

    return { total, deliveries: rows }
  }

  /**
   * Create a webhook. It starts out pending: no event has reached it yet.
   *
   * @returns The new webhook's ID
   */
  async createHook(values: {
    name: string
    events: string[]
    url: string
    includeMetadata?: boolean
    includeContent?: boolean
    acceptUntrusted?: boolean
    authHeader?: string
    // -> Null (or omitted) means "all sites" — see the column comment in `db/schema.ts`
    siteId?: string | null
  }): Promise<string> {
    const result = await WIKI.db
      .insert(hooksTable)
      .values({
        name: values.name,
        events: values.events,
        url: values.url,
        includeMetadata: values.includeMetadata ?? true,
        includeContent: values.includeContent ?? false,
        acceptUntrusted: values.acceptUntrusted ?? false,
        authHeader: values.authHeader ?? null,
        state: 'pending',
        siteId: values.siteId ?? null
      })
      .returning({ id: hooksTable.id })
    return result[0].id
  }

  /**
   * Update a webhook.
   *
   * Changing where or what it sends resets the state to pending: the previous outcome says nothing
   * about the new configuration.
   *
   * @returns Whether a webhook was updated
   */
  async updateHook(id: string, patch: Record<string, any>): Promise<boolean> {
    const values: Record<string, any> = { ...patch, updatedAt: sql`now()` }
    if (patch.url !== undefined || patch.events !== undefined || patch.authHeader !== undefined) {
      values.state = 'pending'
      values.lastErrorMessage = null
    }
    const result = await WIKI.db.update(hooksTable).set(values).where(eq(hooksTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Delete a webhook
   *
   * @returns Whether a webhook was deleted
   */
  async deleteHook(id: string): Promise<boolean> {
    const result = await WIKI.db.delete(hooksTable).where(eq(hooksTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Queue a delivery for every webhook subscribed to an event.
   *
   * Safe to call from anywhere, including request handlers: it only writes jobs, and it never throws
   * — a webhook problem must not fail the action that triggered it.
   *
   * @param siteId Which site the event happened on, or `null` for an event with no site context
   *                (`user:join`/`user:login`/`user:logout` — users are global entities). A hook
   *                scoped to one site (`hooks.siteId` set) only fires for that exact site; a hook
   *                scoped to every site (`hooks.siteId` null) always fires. This means a site-scoped
   *                hook deliberately does NOT receive a `siteId: null` event: "no site context" is not
   *                a wildcard match against a specific site, the same way a site-scoped API key's
   *                permissions don't extend to an action that has no page/site context either.
   * @param data Event-specific payload. `metadata` and `content` are stripped per webhook, according
   *             to what each one asked for.
   * @returns How many webhook deliveries were queued. Does not count the email fan-out below — see
   *          {@link notifyEmailSubscribers} — which is an independent channel with its own count
   *          nobody outside this method has ever needed to know.
   */
  async emit(
    event: HookEvent,
    siteId: string | null,
    data: Record<string, any> = {}
  ): Promise<number> {
    let queued = 0
    try {
      const siteFilter = siteId
        ? sql`(${hooksTable.siteId} IS NULL OR ${hooksTable.siteId} = ${siteId})`
        : sql`${hooksTable.siteId} IS NULL`
      const subscribed = await WIKI.db
        .select({
          id: hooksTable.id,
          includeMetadata: hooksTable.includeMetadata,
          includeContent: hooksTable.includeContent
        })
        .from(hooksTable)
        .where(and(sql`${event} = ANY(${hooksTable.events})`, siteFilter))

      const policy = webhookRateLimitPolicy()
      for (const hook of subscribed) {
        const verdict = await WIKI.models.rateLimits.consume(`webhook:${hook.id}`, policy)
        if (!verdict.allowed) {
          // -> Admission decision, not a delivery outcome: the hook's persisted `state` describes
          //    what happened to an attempted delivery (pending/success/error), and this delivery was
          //    never attempted. A warn line is the only trace of it, same as the queueing failure
          //    below.
          WIKI.logger.warn(
            `Webhook ${hook.id} is over its delivery rate limit (${verdict.hits}/${policy.max} in the current window); skipping delivery of ${event}.`
          )
          continue
        }
        const { metadata, content, ...rest } = data
        const payload = {
          ...rest,
          ...(hook.includeMetadata && metadata !== undefined ? { metadata } : {}),
          ...(hook.includeContent && content !== undefined ? { content } : {})
        }
        const added = await WIKI.scheduler.addJob({
          task: 'dispatchWebhook',
          // -> The instance travels with the job because the delivery does not happen here: it runs
          //    in a worker thread, whose `INSTANCE_ID` names the thread rather than the wiki, and
          //    what a subscriber wants to know is which instance the event came from
          payload: { hookId: hook.id, event, data: payload, instance: WIKI.INSTANCE_ID }
        })
        if (added?.id) {
          queued++
        }
      }
    } catch (err: any) {
      WIKI.logger.warn(`Failed to queue webhook deliveries for ${event}: ${err.message}`)
    }

    // -> Two further, independent fan-outs for the same event — see `notifyEmailSubscribers`'s and
    //    `queueEventSubscriberNotifications`'s own doc comments for why each is separate from (and
    //    cannot affect) the webhook queueing above, or each other.
    await this.notifyEmailSubscribers(event, siteId, data)
    await this.queueEventSubscriberNotifications(event, data)

    return queued
  }

  /**
   * Queue an email notification job for every user subscribed (`WIKI.models.users
   * .listEmailSubscribers`) to this event type — the email half of `emit()`'s fan-out, alongside the
   * webhook queueing above. Independent of it on purpose: a broken webhook lookup must not stop a
   * subscribed user from being emailed, and vice versa, so each has its own `try`/`catch` rather than
   * sharing one — the same "safe to call from anywhere, never throws" contract `emit()` itself
   * documents.
   *
   * Resolves the subscriber list once, here, and hands the resolved ids to the job — never re-queries
   * at delivery time — matching `models/pages.ts#notifyWatchers`'s convention for
   * `notifyPageWatchers` (see that job's own doc comment for why: an event's context can be gone by
   * the time a queued job actually runs, e.g. a delete).
   */
  private async notifyEmailSubscribers(
    event: HookEvent,
    siteId: string | null,
    data: Record<string, any>
  ): Promise<void> {
    try {
      const subscribers = await WIKI.models.users.listEmailSubscribers(event)
      if (subscribers.length < 1) {
        return
      }
      await WIKI.scheduler.addJob({
        task: 'notifyEventSubscribers',
        payload: {
          event,
          siteId,
          data,
          subscribers: subscribers.map((user) => ({ userId: user.id }))
        }
      })
    } catch (err: any) {
      WIKI.logger.warn(`Failed to queue email notifications for ${event}: ${err.message}`)
    }
  }

  /**
   * Queue one batched notification job for every user subscribed to this event
   * (`models/eventSubscriptions.ts`) -- the per-user counterpart to the webhook fan-out `emit()`
   * already does above, added for OpenProject #2484. A single job carrying every subscriber's id,
   * mirroring `models/pages.ts#notifyWatchers`'s own one-job-per-change batching, rather than one job
   * per subscriber.
   *
   * A separate task (`notifyEventSubscriptionSubscribers`, not `notifyEventSubscribers`) from
   * {@link notifyEmailSubscribers}'s job above on purpose: the two read from different subscription
   * stores (`models/eventSubscriptions.ts`'s dedicated table here, vs. `users.prefs.notifications
   * .events` there) and hand their task a differently-shaped payload, so sharing one task name would
   * mean one task guessing which shape it received.
   *
   * Never throws, matching `emit()`'s own "safe to call from anywhere" contract: a failure here must
   * not affect `emit()`'s webhook-queued count, which is why this is a separate try/catch from the
   * webhook loop above rather than folded into it.
   */
  private async queueEventSubscriberNotifications(
    event: HookEvent,
    data: Record<string, any>
  ): Promise<void> {
    try {
      const subscriberIds = await WIKI.models.eventSubscriptions.listSubscribers(event)
      if (subscriberIds.length < 1) {
        return
      }
      await WIKI.scheduler.addJob({
        task: 'notifyEventSubscriptionSubscribers',
        payload: { event, data, subscriberIds }
      })
    } catch (err: any) {
      WIKI.logger.warn(
        `Failed to queue event-subscriber notifications for ${event}: ${err.message}`
      )
    }
  }

  /**
   * Deliver one event to one webhook, recording the outcome on the webhook.
   *
   * Called by the `dispatchWebhook` task, which runs in a worker thread — so everything it needs
   * comes from the job or the database, and `instance` in particular is the one that queued the
   * delivery rather than whatever thread is making it.
   *
   * Throws on failure so that the scheduler retries it.
   */
  async deliver({
    hookId,
    event,
    data,
    instance
  }: {
    hookId: string
    event: string
    data: Record<string, any>
    instance: string
  }): Promise<void> {
    const hook = await this.getHookById(hookId)
    if (!hook) {
      // -> Deleted between queueing and delivery; nothing to do and nothing to retry
      WIKI.logger.info(`Webhook ${hookId} no longer exists, skipping delivery of ${event}.`)
      return
    }

    const body = JSON.stringify({
      event,
      sentAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      instance,
      data
    })

    try {
      const { statusCode } = await postJson(hook.url, body, {
        authHeader: hook.authHeader,
        acceptUntrusted: hook.acceptUntrusted
      })
      if (statusCode < 200 || statusCode > 299) {
        throw new Error(`The endpoint answered with HTTP ${statusCode}.`)
      }
      await WIKI.db
        .update(hooksTable)
        .set({ state: 'success', lastErrorMessage: null })
        .where(eq(hooksTable.id, hook.id))
      WIKI.logger.debug(`Delivered ${event} to webhook ${hook.name} [ OK ]`)
    } catch (err: any) {
      await WIKI.db
        .update(hooksTable)
        .set({ state: 'error', lastErrorMessage: err.message })
        .where(eq(hooksTable.id, hook.id))
      WIKI.logger.warn(`Failed to deliver ${event} to webhook ${hook.name}: ${err.message}`)
      // -> Rethrown so the job fails and the scheduler retries with its usual backoff
      throw err
    }
  }
}

export const hooks = new Hooks()

/**
 * Tell the outside world that a page or an asset changed: webhooks first, then storage targets.
 *
 * Ten write paths across `models/pages.ts` and `models/assets.ts` — create, edit, rename, delete and
 * the folder-cascade delete, for each of the two content kinds — each ended with the same pair of
 * awaited calls carrying near-identical payloads. What actually differs between the two calls is
 * small and fixed: a webhook may be given `metadata` (whatever a subscriber asked to be told beyond
 * the identity of the thing that changed), while a storage dispatch may be given the couple of extra
 * columns a target needs to classify the content (`kind`/`fileSize`).
 *
 * A module function rather than a method on `Hooks`, because both call sites are other models and
 * both of their test suites stand `WIKI.models.hooks` up as a bare `{ emit }` stub — a method here
 * would not exist on those stubs, while this reads `WIKI.models.hooks.emit` and
 * `WIKI.models.storage.dispatch` at call time, exactly as the inlined copies did.
 *
 * Both calls are awaited in this order, deliberately: `assets.test.ts` asserts that an upload does
 * not resolve until both have. The payloads are what external consumers actually receive, so they are
 * assembled here to be byte-identical to what each site sent before (`pages.test.ts` and
 * `assets.test.ts` assert them field for field) — `data` carries its own `siteId` in its own
 * position rather than having one spliced in here.
 *
 * @param data The shared payload, sent as-is to both
 * @param extra.metadata Merged into the webhook payload only, as `metadata`
 * @param extra.dispatchExtra Merged into the storage-dispatch payload only
 */
export async function announce(
  event: HookEvent,
  siteId: string,
  data: Record<string, unknown>,
  extra: {
    metadata?: Record<string, unknown>
    dispatchExtra?: Record<string, unknown>
  } = {}
): Promise<void> {
  await WIKI.models.hooks.emit(
    event,
    siteId,
    extra.metadata ? { ...data, metadata: extra.metadata } : data
  )
  await WIKI.models.storage.dispatch(
    event,
    extra.dispatchExtra ? { ...data, ...extra.dispatchExtra } : data
  )
}
