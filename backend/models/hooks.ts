import http from 'node:http'
import https from 'node:https'
import { hooks as hooksTable, jobHistory as jobHistoryTable } from '../db/schema.ts'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { durationToSeconds } from '../helpers/common.ts'
import { paginate } from '../helpers/pagination.ts'
import type { JobState } from './jobs.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

/** Every event a webhook may subscribe to; {@link EMITTED_EVENTS} is the subset anything fires. */
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
 * The events something in the server actually emits. Explicit rather than inferred from
 * {@link HOOK_EVENTS}, since a new entry there does not necessarily have an `emit()` call wired up
 * yet. Add an event here when you add its `emit()` call.
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

export type Hook = typeof hooksTable.$inferSelect

export interface HookDelivery {
  event: string
  state: JobState
  attempt: number
  maxRetries: number
  lastErrorMessage: string | null
  startedAt: Date
  completedAt: Date | null
}

export interface HookDeliveryPage {
  total: number
  deliveries: HookDelivery[]
}

const DELIVERY_TIMEOUT = 15000

/**
 * Fallback per-webhook delivery rate limit, used until an operator configures their own and whenever
 * a stored value is unusable. Sixty a minute far exceeds any legitimate burst of these events, and is
 * what keeps one busy hook from flooding either its endpoint or the shared job queue.
 */
const WEBHOOK_RATE_LIMIT_DEFAULTS: RateLimitPolicy = {
  max: 60,
  windowSeconds: 60,
  banSeconds: 60
}

/**
 * Every field falls back on its own, and the two durations are stored as an operator wrote them
 * (`1m`, `5m`) rather than as raw seconds.
 */
function webhookRateLimitPolicy(): RateLimitPolicy {
  const scheduler = CARDINAL.config.scheduler ?? {}
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
 * `node:https` rather than `fetch`: a webhook may legitimately point at an endpoint with a
 * self-signed certificate, and per-request TLS options are not expressible through fetch.
 *
 * Exported for `POST /hooks/test`, a synthetic delivery to a URL that need not belong to any saved
 * webhook and so cannot go through `deliver()`, which reads and writes a persisted hook's state.
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
          'user-agent': `Cardinal.js/${CARDINAL.version}`,
          ...(authHeader ? { authorization: authHeader } : {})
        },
        timeout: DELIVERY_TIMEOUT,
        // -> Not a blanket TLS bypass: `acceptUntrusted` is a per-webhook admin opt-in, default
        // false, applying only when the target is already `https:`. Intentional, for webhook targets
        // on self-signed/internal certs — see docs/decisions/
        // 2026-09-17-webhook-accept-untrusted-tls-opt-in.md. Scanners grepping for
        // `rejectUnauthorized: false` (Semgrep's bypass-tls-verification) flag this line.
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
 * Webhooks POST a JSON body to a remote endpoint when something happens. Delivery goes through the
 * scheduler rather than the request that triggered it: a slow or broken endpoint must not delay a
 * user's action, and the scheduler already provides retries and a place to see failures.
 */
class Hooks {
  async getHooks(): Promise<Hook[]> {
    const results = await CARDINAL.db.select().from(hooksTable).orderBy(desc(hooksTable.createdAt))
    return results
  }

  async getHookById(id: string): Promise<Hook | null> {
    const results = await CARDINAL.db
      .select()
      .from(hooksTable)
      .where(eq(hooksTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * A webhook's delivery history, most recently started first.
   *
   * Backed by `jobHistory` — `deliver()` runs as the `dispatchWebhook` task and every attempt is
   * already recorded there, so this reads that log rather than keeping a second one. Retention is
   * therefore `jobHistory`'s own, deliberately: the durable "is this webhook healthy" signal is
   * `hooks.state` / `hooks.lastErrorMessage`, which never expires, so this is recent-attempts
   * diagnostics rather than an audit log.
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
        CARDINAL.db
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
      total: () => CARDINAL.db.select({ total: count() }).from(jobHistoryTable).where(where)
    })

    return { total, deliveries: rows }
  }

  /** Starts out pending: no event has reached it yet. Returns the new webhook's id. */
  async createHook(values: {
    name: string
    events: string[]
    url: string
    includeMetadata?: boolean
    includeContent?: boolean
    acceptUntrusted?: boolean
    authHeader?: string
    // -> Null (or omitted) means every site
    siteId?: string | null
  }): Promise<string> {
    const result = await CARDINAL.db
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
   * Changing where or what a webhook sends resets its state to pending: the previous outcome says
   * nothing about the new configuration.
   */
  async updateHook(id: string, patch: Record<string, any>): Promise<boolean> {
    const values: Record<string, any> = { ...patch, updatedAt: sql`now()` }
    if (patch.url !== undefined || patch.events !== undefined || patch.authHeader !== undefined) {
      values.state = 'pending'
      values.lastErrorMessage = null
    }
    const result = await CARDINAL.db.update(hooksTable).set(values).where(eq(hooksTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  async deleteHook(id: string): Promise<boolean> {
    const result = await CARDINAL.db.delete(hooksTable).where(eq(hooksTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Queue a delivery for every webhook subscribed to an event.
   *
   * Safe to call from anywhere, including request handlers: it only writes jobs, and it never throws
   * — a webhook problem must not fail the action that triggered it.
   *
   * @param siteId `null` for an event with no site context (`user:*` — users are global entities).
   *               A hook scoped to one site only fires for that exact site, so it deliberately does
   *               NOT receive a `siteId: null` event: "no site context" is not a wildcard match.
   * @param data `metadata` and `content` are stripped per webhook, per what each one asked for.
   * @returns How many webhook deliveries were queued, not counting the independent email fan-out.
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
      const subscribed = await CARDINAL.db
        .select({
          id: hooksTable.id,
          includeMetadata: hooksTable.includeMetadata,
          includeContent: hooksTable.includeContent
        })
        .from(hooksTable)
        .where(and(sql`${event} = ANY(${hooksTable.events})`, siteFilter))

      const policy = webhookRateLimitPolicy()
      for (const hook of subscribed) {
        const verdict = await CARDINAL.models.rateLimits.consume(`webhook:${hook.id}`, policy)
        if (!verdict.allowed) {
          // -> Admission decision, not a delivery outcome: the hook's persisted `state` describes an
          //    attempted delivery, and this one never was. The warn line is its only trace.
          CARDINAL.logger.warn(
            'hooks',
            'webhook is over its delivery rate limit, skipping delivery',
            {
              hook: hook.id,
              event,
              hits: verdict.hits,
              max: policy.max
            }
          )
          continue
        }
        const { metadata, content, ...rest } = data
        const payload = {
          ...rest,
          ...(hook.includeMetadata && metadata !== undefined ? { metadata } : {}),
          ...(hook.includeContent && content !== undefined ? { content } : {})
        }
        const added = await CARDINAL.scheduler.addJob({
          task: 'dispatchWebhook',
          // -> The instance travels with the job: delivery runs in a worker thread, whose
          //    `INSTANCE_ID` names the thread rather than the wiki a subscriber wants named
          payload: { hookId: hook.id, event, data: payload, instance: CARDINAL.INSTANCE_ID }
        })
        if (added?.id) {
          queued++
        }
      }
    } catch (err: any) {
      CARDINAL.logger.warn('hooks', 'queueing the webhook deliveries failed', { event, error: err })
    }

    await this.notifyEmailSubscribers(event, siteId, data)

    return queued
  }

  /**
   * The email half of `emit()`'s fan-out. Independent of the webhook queueing on purpose, with its
   * own `try`/`catch` rather than a shared one: a broken webhook lookup must not stop a subscribed
   * user being emailed, or the reverse.
   *
   * Resolves the subscriber list here and hands the ids to the job rather than re-querying at
   * delivery time, because the event's context can be gone by then (a delete, say).
   */
  private async notifyEmailSubscribers(
    event: HookEvent,
    siteId: string | null,
    data: Record<string, any>
  ): Promise<void> {
    try {
      const subscribers = await CARDINAL.models.users.listEmailSubscribers(event)
      if (subscribers.length < 1) {
        return
      }
      await CARDINAL.scheduler.addJob({
        task: 'notifyEventSubscribers',
        payload: {
          event,
          siteId,
          data,
          subscribers: subscribers.map((user) => ({ userId: user.id }))
        }
      })
    } catch (err: any) {
      CARDINAL.logger.warn('hooks', 'queueing the email notifications failed', {
        event,
        error: err
      })
    }
  }

  /**
   * Runs as the `dispatchWebhook` task in a worker thread, so everything it needs comes from the job
   * or the database — `instance` in particular is whichever instance queued the delivery, not the
   * thread making it.
   *
   * Throws on failure so the scheduler retries.
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
      CARDINAL.logger.debug('hooks', 'webhook no longer exists, skipping delivery', {
        hook: hookId,
        event
      })
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
      await CARDINAL.db
        .update(hooksTable)
        .set({ state: 'success', lastErrorMessage: null })
        .where(eq(hooksTable.id, hook.id))
      CARDINAL.logger.debug('hooks', 'delivered to webhook', { hook: hook.id, event })
    } catch (err: any) {
      await CARDINAL.db
        .update(hooksTable)
        .set({ state: 'error', lastErrorMessage: err.message })
        .where(eq(hooksTable.id, hook.id))
      CARDINAL.logger.warn('hooks', 'delivering to the webhook failed', {
        hook: hook.id,
        event,
        error: err
      })
      throw err
    }
  }
}

export const hooks = new Hooks()

/**
 * Tell the outside world that a page or an asset changed: webhook emit, then storage dispatch, both
 * awaited in that order — `assets.test.ts` asserts an upload does not resolve until both have.
 *
 * A module function rather than a method on `Hooks`, because both call sites are other models whose
 * test suites stand `CARDINAL.models.hooks` up as a bare `{ emit }` stub — a method here would not
 * exist on those stubs, while this reads `CARDINAL.models.hooks.emit` at call time.
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
  await CARDINAL.models.hooks.emit(
    event,
    siteId,
    extra.metadata ? { ...data, metadata: extra.metadata } : data
  )
  await CARDINAL.models.storage.dispatch(
    event,
    extra.dispatchExtra ? { ...data, ...extra.dispatchExtra } : data
  )
}
