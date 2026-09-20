import { and, count, desc, eq, gte, lte } from 'drizzle-orm'
import { auditLog as auditLogTable, users as usersTable } from '../db/schema.ts'
import { paginate } from '../helpers/pagination.ts'
import type { FastifyRequest } from 'fastify'

/**
 * Every event kind this table records, grouped by the subject it happened to. A closed vocabulary,
 * like the permission lists: a caller passes one of these strings, never an assembled one.
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
  /** `detail` carries `{ from, to }` (level ids), so a listing can say what changed in one read. */
  'page.classificationChanged',
  // -> MCP activity, deliberately only these two rather than one per read tool call as well: a read
  //   on a busy agent integration would be noisy at this table's granularity, while a session
  //   opening and a write are what "what can an agent holding my token reach" actually needs.
  'mcp.sessionOpened',
  'mcp.writeToolCalled',
  // -> Instance-wide administration, with no per-target row of its own (no `targetType` fits), so
  //   `detail` alone carries what changed. For `flagsUpdated`/`securityUpdated` it is the exact
  //   `patch` `pickFlags`/`pickFields` produced, already filtered to each model's own closed field
  //   list -- which is what keeps an `auth`/`mail` settings blob out of it even if the request body
  //   carried one.
  'system.flagsUpdated',
  'system.securityUpdated',
  'system.extensionInstalled',
  'system.apiStateUpdated',
  'system.metricsUpdated',
  'system.pageviewsUpdated',
  // -> Same filtered-patch `detail` as the siblings above, with `bearerToken` masked rather than
  //   dropped: the diff stays visible without the raw secret reaching the log.
  'system.replicationUpdated',
  // -> Rotating `pageviews.hashKey` breaks correlation between pre- and post-rotation
  //   `visitorHash` rows, on purpose.
  'system.pageviewsHashKeyRotated',
  'system.certificatesRegenerated',
  'system.sessionsInvalidated',
  'system.pageHistoryPurged',
  'system.contentExported',
  'system.contentImported',
  'system.wysiwygJsonConverted',
  'system.sampleContentGenerated',
  'system.sampleContentPurged',
  // -> The whole instance in the replication archive format, not `system.contentExported`'s
  //   per-site "Export content" utility.
  'system.replicationSnapshotExported',
  // -> A whole-instance wipe-and-replace snapshot restore, not `system.contentImported`'s one site.
  'system.replicationImported',
  /**
   * The audit log auditing its own configuration. `retentionChanged`'s `detail` carries
   * `{ from, to }` (days); `purged`'s carries `{ count, cutoff }`.
   */
  'auditLog.retentionChanged',
  'auditLog.purged'
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

export const AUDIT_TARGET_TYPES = [
  'user',
  'group',
  'apiKey',
  'site',
  'storageTarget',
  'authStrategy',
  // -> `mcp.writeToolCalled` targets the page or asset the tool wrote, not the calling key (that is
  //   `mcp.sessionOpened`'s `apiKey` target), so the entry answers what the agent wrote.
  'page',
  'asset',
  'glossaryTerm',
  // -> For a `system.*`/`auth.*`/`auditLog.*` event there is no row to point at, so `targetId`
  //   stays '' and `targetLabel` names the setting or module changed instead.
  'system'
] as const

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365

/**
 * The lowest `retentionDays` `PUT /_api/audit-log/settings` accepts.
 *
 * Without a floor the pieces compose into a wipe: `purge()` reads the retention value live and the
 * `cleanAuditLog` job can be run on demand, so a `manage:system` session could set a one-day
 * window, trigger the job and restore the old value. This is not tamper-evidence -- see `purge()`
 * -- it only stops a single retention change from functioning as a full wipe.
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

/** A session user, an API key, or nobody (a job). */
export type AuditActor = {
  id: string | null
  name: string
  ip?: string
}

/**
 * A route calls this rather than reading `req.session.user` itself so every write site agrees on
 * what an API-key-authenticated request is attributed as: the key carries no user identity of its
 * own, so it is named by its id rather than left blank.
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
 * An append-only record of instance-wide, permission-affecting events -- see the table's own doc
 * comment in `db/schema.ts` for what is and is not in scope. Written from the API layer, where the
 * acting session/API key is already resolved, rather than threaded through every model method that
 * changes something.
 */
class AuditLog {
  /**
   * Record one event. A failure here is logged and swallowed: the log is a record of what happened,
   * and losing an entry is never a reason to fail the action that produced it.
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
      await CARDINAL.db.insert(auditLogTable).values({
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
      CARDINAL.logger.warn('audit', 'recording the audit log entry failed', { event, error: err })
    }
  }

  /**
   * Record N events in one INSERT, for a caller that already holds a whole set of entries and would
   * otherwise write them one at a time. An empty array is a no-op rather than a zero-row INSERT,
   * and a failure is swallowed the same way `record()`'s is.
   */
  async recordMany(entries: RecordEntry[]): Promise<void> {
    if (entries.length < 1) {
      return
    }
    try {
      await CARDINAL.db.insert(auditLogTable).values(
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
      CARDINAL.logger.warn('audit', 'recording the audit log entries failed', {
        entries: entries.length,
        error: err
      })
    }
  }

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
        CARDINAL.db
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
      total: () => CARDINAL.db.select({ total: count() }).from(auditLogTable).where(where)
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
   * Every distinct actor who has appeared in the log, resolved against the live `users` table
   * rather than the log's own snapshotted names, so a renamed account shows its current name. The
   * snapshot on old rows is only there to survive the account being deleted.
   */
  async listActors(): Promise<{ id: string; name: string }[]> {
    const rows = await CARDINAL.db
      .selectDistinct({ id: usersTable.id, name: usersTable.name })
      .from(auditLogTable)
      .innerJoin(usersTable, eq(usersTable.id, auditLogTable.actorId))
      .orderBy(usersTable.name)
    return rows
  }

  /** Drop every entry older than `retentionDays`, answering with how many went. */
  async purge(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ hours: retentionDays * 24 }).epochMilliseconds
    )
    const result = await CARDINAL.db
      .delete(auditLogTable)
      .where(lte(auditLogTable.createdAt, cutoff))
    const purged = result.rowCount ?? 0
    // -> Silent at `info` when there was nothing to purge; this runs from a scheduled job.
    if (purged > 0) {
      CARDINAL.logger.info('audit', 'purged old audit log entries', {
        entries: purged,
        retentionDays
      })
    } else {
      CARDINAL.logger.debug('audit', 'no audit log entries to purge', { retentionDays })
    }
    // -> Recording the purge leaves a trail of what a shortened window did (no actor: this runs
    //    from the `cleanAuditLog` job). Not tamper-evidence, though -- the entry lives in the table
    //    it just deleted from, so a later, shorter window eats it in turn. That would need a
    //    `BEFORE DELETE` trigger admitting only the retention predicate, or an external sink.
    await this.record({
      event: 'auditLog.purged',
      actor: { id: null, name: '' },
      detail: { count: purged, cutoff: cutoff.toISOString() }
    })
    return purged
  }

  getRetentionDays(): number {
    return CARDINAL.config.auditLog?.retentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS
  }

  async setRetentionDays(retentionDays: number): Promise<boolean> {
    CARDINAL.config.auditLog = { retentionDays }
    return CARDINAL.configSvc.saveToDb(['auditLog'])
  }
}

export const auditLog = new AuditLog()
