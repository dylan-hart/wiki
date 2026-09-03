import { and, count, desc, eq, gte, lte } from 'drizzle-orm'
import { auditLog as auditLogTable, users as usersTable } from '../db/schema.ts'
import { paginate } from '../helpers/pagination.ts'
import type { FastifyRequest } from 'fastify'

/**
 * Every event kind this table records, grouped by the subject it happened to. Closed, the same way
 * `PAGE_PERMISSIONS` and the two permission lists in CLAUDE.md are closed -- a caller passes one of
 * these strings, never an assembled one.
 */
export const AUDIT_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'user.passwordReset',
  'user.tfaDisabledByAdmin',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.memberAdded',
  'group.memberRemoved',
  'apiKey.issued',
  'apiKey.revoked',
  'site.settingsUpdated',
  'storage.targetUpdated',
  'auth.strategyUpdated',
  'glossaryTerm.created',
  'glossaryTerm.updated',
  'glossaryTerm.deleted',
  'login.success',
  'login.failed',
  /**
   * OpenProject #1081: a page's classification changed, either way -- a raise or a lowering
   * (`manage:classification`-guarded), an auto-bump on move, or a bulk resolve of a classification
   * conflict. `detail` carries `{ from, to }` (level ids) so the listing can say what changed without
   * a second lookup.
   */
  'page.classificationChanged',
  // -> #1118: MCP activity. Deliberately only these two, not one per read tool call too -- a read on
  //   a busy agent integration (`search_pages`/`get_page`/`list_navigation`/`list_sites`) would be
  //   noisy at this table's granularity with little corresponding benefit, while a session opening and
  //   a write are exactly the two things "what can an agent holding my token actually reach" needs
  //   answered here. Instrumented in `mcp/http.ts` (session lifecycle, HTTP transport) and
  //   `mcp/stdio.ts` (session lifecycle, stdio transport) for the former, and `mcp/tools/createPage.ts`
  //   /`updatePage.ts` for the latter -- the write tools are the same handlers regardless of which
  //   transport called them, so this fires for both.
  'mcp.sessionOpened',
  'mcp.writeToolCalled',
  // -> #2231: every write route in `api/system/` -- instance-wide administration with no per-target
  //   row of its own (no `targetType` fits), so `detail` alone carries what changed. For
  //   `flagsUpdated`/`securityUpdated`, `detail` is the exact `patch` object `pickFlags`/`pickFields`
  //   already produced -- filtered to each model's own closed field list, which is what guarantees an
  //   `auth`/`mail` settings blob (never in either list) can never reach it even if a caller's request
  //   body carried one.
  'system.flagsUpdated',
  'system.securityUpdated',
  'system.extensionInstalled',
  'system.apiStateUpdated',
  'system.metricsUpdated',
  'system.pageviewsUpdated',
  // -> #2491: an operator changed the instance-level scheduled-replication settings (source URL,
  //   bearer token, cron schedule, or the enable toggle). `detail` is the same filtered patch
  //   pattern as the siblings above, with `bearerToken` masked rather than dropped, so a diff of
  //   what changed stays visible without ever writing the raw secret to the log.
  'system.replicationUpdated',
  // -> #2288: an operator rotated `pageviews.hashKey`, breaking correlation between pre- and
  //   post-rotation `visitorHash` rows on purpose.
  'system.pageviewsHashKeyRotated',
  'system.certificatesRegenerated',
  'system.sessionsInvalidated',
  'system.pageHistoryPurged',
  'system.contentExported',
  'system.contentImported',
  // -> #2489: an instance-wide replication snapshot was queued (Epic #2437's scheduled clean-slate
  //   replication, source side). Distinct from `system.contentExported`, which is the existing
  //   per-site "Export content" utility -- this is the whole instance, a different archive format,
  //   and a different feature.
  'system.replicationSnapshotExported',
  // -> Feature #2437: a whole-instance wipe-and-replace snapshot restore, distinct from
  //   `system.contentImported` (one site's content) — see `models/replicationImport.ts`.
  'system.replicationImported',
  /**
   * OpenProject #2237: the audit log auditing its own configuration. `retentionChanged`'s `detail`
   * carries `{ from, to }` (days); `purged`'s carries `{ count, cutoff }` -- see `purge()`'s own
   * comment for why recording this is necessary but not sufficient to make the log tamper-evident on
   * its own.
   */
  'auditLog.retentionChanged',
  'auditLog.purged'
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** What kind of thing an event happened to. */
export const AUDIT_TARGET_TYPES = [
  'user',
  'group',
  'apiKey',
  'site',
  'storageTarget',
  'authStrategy',
  // -> #1118: `mcp.writeToolCalled`'s target is the page (or, per #2446, the asset) the tool call
  //   wrote, not the calling key (that's `mcp.sessionOpened`'s `apiKey` target) -- naming the target
  //   is what makes the log entry answer "what did the agent write", not just "an agent wrote
  //   something".
  'page',
  // -> #2443/#2445/#2446: `mcp.writeToolCalled`'s target for `upload_asset`, `rename_asset` and
  //   `delete_asset`, the same reasoning as `page` above applied to the asset write tools.
  'asset',
  'glossaryTerm',
  // -> #2229: the target of a `system.*`/`auth.*`/`auditLog.*` event -- there is no row to point at,
  //   so `targetId` for these stays '' and `targetLabel` names the setting/module changed instead.
  'system'
] as const

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

/** How long, in days, a fresh instance keeps audit log entries before the retention job trims them. */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365

/**
 * The lowest `retentionDays` `PUT /_api/audit-log/settings` will accept (OpenProject #2237).
 *
 * The route used to allow `1`. Combined with `POST /_api/scheduler/schedule/:scheduleId/run`
 * queueing the seeded `cleanAuditLog` job immediately rather than waiting for its 00:35 cron, and
 * `purge()` reading the retention value live at run time, an operator -- or a compromised
 * `manage:system` session or API key -- could set `retentionDays: 1`, trigger the job, and delete
 * effectively the whole log in one `delete` before restoring a longer window: a de facto wipe with
 * no trace beyond a `WIKI.logger.info` line naming no actor. This floor does not make the log
 * tamper-evident by itself (see `purge()`'s own comment below), but it does mean a single retention
 * change can no longer function as a full wipe.
 */
export const AUDIT_LOG_RETENTION_DAYS_FLOOR = 30

export type AuditLogEntry = {
  id: string
  event: AuditEvent
  actor: {
    id: string | null
    name: string
  }
  actorIp: string
  targetType: string
  targetId: string
  targetLabel: string
  detail: Record<string, any>
  siteId: string | null
  createdAt: Date
}

export type AuditLogPage = {
  total: number
  entries: AuditLogEntry[]
}

/** Who did this, as every write site resolves it -- a session user, an API key, or nobody (a job). */
export type AuditActor = {
  id: string | null
  name: string
  ip?: string
}

/**
 * Who made this request, for the audit log's `actor` -- a logged-in session, an API key, or nobody.
 *
 * A route calls this rather than reading `req.session.user` itself so that every write site agrees
 * on what an API-key-authenticated request is attributed as: the key carries no user identity of its
 * own (see `ApiKeyIdentity` in `models/apiKeys.ts`), so it is named by its id rather than left blank.
 */
export function actorFromRequest(req: FastifyRequest): AuditActor {
  if (req.session?.user) {
    return { id: req.session.user.id, name: req.session.user.name, ip: req.ip }
  }
  if (req.apiKey) {
    return { id: null, name: `API Key ${req.apiKey.id}`, ip: req.ip }
  }
  return { id: null, name: '', ip: req.ip }
}

/** The entry shape `record()` and `recordMany()` both accept -- one event to write. */
export type RecordEntry = {
  event: AuditEvent
  actor: AuditActor
  targetType?: AuditTargetType | ''
  targetId?: string
  targetLabel?: string
  detail?: Record<string, any>
  siteId?: string | null
}

/**
 * Audit log model
 *
 * An append-only record of instance-wide, permission-affecting events -- see the table's own doc
 * comment in `db/schema.ts` for what is and is not in scope. Written from the API layer, where the
 * acting session/API key is already resolved, rather than threaded through every model method that
 * changes something.
 */
class AuditLog {
  /**
   * Record one event.
   *
   * A failure here is logged and swallowed, the same as `pageHistory.record()`: the log is a record
   * of what happened, and losing an entry is never a reason to fail the action that produced it.
   */
  async record({
    event,
    actor,
    targetType = '',
    targetId = '',
    targetLabel = '',
    detail = {},
    siteId = null
  }: RecordEntry): Promise<void> {
    try {
      await WIKI.db.insert(auditLogTable).values({
        event,
        actorId: actor.id,
        actorName: actor.name,
        actorIp: actor.ip ?? '',
        targetType,
        targetId,
        targetLabel,
        detail,
        siteId
      })
    } catch (err: any) {
      WIKI.logger.warn(`Failed to record audit log entry for ${event}: ${err.message}`)
    }
  }

  /**
   * Record N events in one INSERT — the batched form of `record()`, for a caller that already has a
   * whole set of entries in hand and would otherwise write them one at a time (the
   * classification-conflicts resolve route, OpenProject #1902, bumping many pages in one request).
   *
   * An empty array is a no-op, same as `bulkSetClassification`'s own empty-input short-circuit,
   * rather than an error or a zero-row INSERT. A failure here is logged and swallowed, same as
   * `record()` — the log is a record of what happened, and losing entries is never a reason to fail
   * the write that produced them.
   */
  async recordMany(entries: RecordEntry[]): Promise<void> {
    if (entries.length < 1) {
      return
    }
    try {
      await WIKI.db.insert(auditLogTable).values(
        entries.map((entry) => ({
          event: entry.event,
          actorId: entry.actor.id,
          actorName: entry.actor.name,
          actorIp: entry.actor.ip ?? '',
          targetType: entry.targetType ?? '',
          targetId: entry.targetId ?? '',
          targetLabel: entry.targetLabel ?? '',
          detail: entry.detail ?? {},
          siteId: entry.siteId ?? null
        }))
      )
    } catch (err: any) {
      WIKI.logger.warn(`Failed to record ${entries.length} audit log entr(ies): ${err.message}`)
    }
  }

  /**
   * A page of the log, newest first, filtered by whichever of actor/event/date range the caller
   * supplied.
   */
  async list({
    actorId,
    event,
    from,
    to,
    limit = 100,
    offset = 0
  }: {
    actorId?: string
    event?: AuditEvent
    from?: Date
    to?: Date
    limit?: number
    offset?: number
  } = {}): Promise<AuditLogPage> {
    const conditions = [
      actorId ? eq(auditLogTable.actorId, actorId) : undefined,
      event ? eq(auditLogTable.event, event) : undefined,
      from ? gte(auditLogTable.createdAt, from) : undefined,
      to ? lte(auditLogTable.createdAt, to) : undefined
    ].filter((c) => c !== undefined)
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select({
            id: auditLogTable.id,
            event: auditLogTable.event,
            actorId: auditLogTable.actorId,
            actorName: auditLogTable.actorName,
            actorIp: auditLogTable.actorIp,
            targetType: auditLogTable.targetType,
            targetId: auditLogTable.targetId,
            targetLabel: auditLogTable.targetLabel,
            detail: auditLogTable.detail,
            siteId: auditLogTable.siteId,
            createdAt: auditLogTable.createdAt
          })
          .from(auditLogTable)
          .where(where)
          .orderBy(desc(auditLogTable.createdAt))
          .limit(limit)
          .offset(offset),
      total: () => WIKI.db.select({ total: count() }).from(auditLogTable).where(where)
    })

    return {
      total,
      entries: rows.map((row: any) => ({
        id: row.id,
        event: row.event,
        actor: {
          id: row.actorId,
          name: row.actorName
        },
        actorIp: row.actorIp,
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        detail: (row.detail ?? {}) as Record<string, any>,
        siteId: row.siteId,
        createdAt: row.createdAt
      }))
    }
  }

  /**
   * Every distinct actor who has ever appeared in the log, for the admin list's actor filter.
   * Resolved against the live `users` table rather than the log's own snapshotted names, so a
   * renamed account shows its current name in the filter -- the snapshot on old rows is only there
   * to survive the account being deleted.
   */
  async listActors(): Promise<{ id: string; name: string }[]> {
    const rows = await WIKI.db
      .selectDistinct({ id: usersTable.id, name: usersTable.name })
      .from(auditLogTable)
      .innerJoin(usersTable, eq(usersTable.id, auditLogTable.actorId))
      .orderBy(usersTable.name)
    return rows
  }

  /**
   * Drop every entry older than the configured retention window.
   *
   * @param retentionDays How many days of history to keep
   * @returns How many entries were dropped
   */
  async purge(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ hours: retentionDays * 24 }).epochMilliseconds
    )
    const result = await WIKI.db.delete(auditLogTable).where(lte(auditLogTable.createdAt, cutoff))
    const purged = result.rowCount ?? 0
    WIKI.logger.info(
      `Purged ${purged} audit log entr(ies) older than ${retentionDays} day(s) [ OK ]`
    )
    // OpenProject #2237: record the purge itself, so a shortened retention window at least leaves a
    // trail of what it did (actor is nobody -- this runs from the `cleanAuditLog` job, not a
    // request). Necessary but not sufficient on its own: this entry lives in the same table it just
    // deleted from, so a later run's own (possibly shorter) window can still eat it in turn. The
    // durable answer -- a `BEFORE DELETE` trigger on `auditLog` admitting only the retention
    // predicate, or an external sink -- is deliberately out of scope here; file it separately if
    // wanted.
    await this.record({
      event: 'auditLog.purged',
      actor: { id: null, name: '' },
      detail: { count: purged, cutoff: cutoff.toISOString() }
    })
    return purged
  }

  /** The configured retention window, in days. */
  getRetentionDays(): number {
    return WIKI.config.auditLog?.retentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS
  }

  /**
   * Update the retention window, in days.
   *
   * @returns Whether the setting was saved
   */
  async setRetentionDays(retentionDays: number): Promise<boolean> {
    WIKI.config.auditLog = { retentionDays }
    return WIKI.configSvc.saveToDb(['auditLog'])
  }
}

export const auditLog = new AuditLog()
