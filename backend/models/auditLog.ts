import { and, count, desc, eq, gte, lte } from 'drizzle-orm'
import { auditLog as auditLogTable, users as usersTable } from '../db/schema.ts'
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
  'glossaryTerm.created',
  'glossaryTerm.updated',
  'glossaryTerm.deleted',
  'login.success',
  'login.failed'
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** What kind of thing an event happened to. */
export const AUDIT_TARGET_TYPES = [
  'user',
  'group',
  'apiKey',
  'site',
  'storageTarget',
  'glossaryTerm'
] as const

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

/** How long, in days, a fresh instance keeps audit log entries before the retention job trims them. */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365

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
  }: {
    event: AuditEvent
    actor: AuditActor
    targetType?: AuditTargetType | ''
    targetId?: string
    targetLabel?: string
    detail?: Record<string, any>
    siteId?: string | null
  }): Promise<void> {
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

    const totals = await WIKI.db.select({ total: count() }).from(auditLogTable).where(where)
    const rows = await WIKI.db
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
      .offset(offset)

    return {
      total: totals[0]?.total ?? 0,
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
