import crypto from 'node:crypto'
import fastifyCookie from '@fastify/cookie'
import { eq, inArray, sql } from 'drizzle-orm'
import { sessions as sessionsTable, userGroups as userGroupsTable } from '../db/schema.ts'

/**
 * Sessions model
 */
class Sessions {
  /**
   * Signs and unsigns cookie/session values against the CURRENT `auth.secret`, read fresh on every
   * call rather than captured once. Handed to both @fastify/cookie and @fastify/session as their
   * `secret` option (`index.ts`): each treats an already-`{ sign, unsign }`-shaped value as a
   * ready-built signer and calls it directly, rather than wrapping a static string in its own
   * `Signer` once at plugin registration (`@fastify/cookie`'s `signer.js#isSigner` check, mirrored
   * in `@fastify/session`'s own). That is what makes `rotateSecret()` below take effect on a
   * still-running instance with no restart: the very next sign/unsign call after `reloadConfig`
   * refreshes `WIKI.config.auth.secret` (`core/config.ts#subscribeToEvents`) already reads the new
   * one. Mirrors `models/apiKeys.ts#verify`'s equivalent per-call read of
   * `WIKI.config.auth.certs.public`.
   */
  signer = {
    sign: (value: string): string => new fastifyCookie.Signer(WIKI.config.auth.secret).sign(value),
    unsign: (value: string) => new fastifyCookie.Signer(WIKI.config.auth.secret).unsign(value)
  }

  /**
   * Fetch all sessions from a single user
   *
   * @param userId User ID
   * @returns User Sessions
   */
  async getByUser(userId: string) {
    return WIKI.db.select().from(sessionsTable).where(eq(sessionsTable.userId, userId))
  }

  /**
   * Fetch a single session by id
   *
   * @param id Session ID
   * @returns Session data
   */
  async get(id: string): Promise<any> {
    const res = await WIKI.db.select().from(sessionsTable).where(eq(sessionsTable.id, id))
    return res?.[0]?.data ?? null
  }

  /**
   * Set / Update a session
   *
   * @param id Session ID
   * @param data Session Data
   */
  async set(id: string, data: any): Promise<void> {
    await WIKI.db
      .insert(sessionsTable)
      .values([
        {
          id,
          userId: data?.user?.id ?? null,
          data
        }
      ])
      .onConflictDoUpdate({
        target: sessionsTable.id,
        set: {
          data,
          userId: data?.user?.id ?? null,
          updatedAt: sql`now()`
        }
      })
  }

  /**
   * Delete a session
   *
   * @param id Session ID
   */
  async destroy(id: string) {
    return WIKI.db.delete(sessionsTable).where(eq(sessionsTable.id, id))
  }

  /**
   * Delete all sessions from all users
   *
   */
  async clearAllSessions() {
    return WIKI.db.delete(sessionsTable)
  }

  /**
   * Delete all sessions from a single user.
   *
   * `session.groups`/`session.permissions` are snapshots taken at login (`models/users.ts`'s
   * `updateSession`) and otherwise live up to the 30-day cookie age — so this is what makes a
   * deactivation or a group-membership change (OpenProject #936) take effect for an open session
   * immediately rather than on its next login: dropping the row is what logs the browser out on its
   * very next request, the same way `rotateSecret()` above logs out every session at once.
   *
   * @param userId User ID
   */
  async clearSessionsFromUser(userId: string) {
    return WIKI.db.delete(sessionsTable).where(eq(sessionsTable.userId, userId))
  }

  /**
   * Delete every session belonging to a CURRENT member of a group.
   *
   * The group-wide counterpart to `clearSessionsFromUser()` above: a group's global `permissions`
   * column is also flattened onto `session.permissions` at login, so revoking one there is just as
   * stale for every member's open session as revoking it from one user directly — this is what
   * `models/groups.ts`'s own `reloadCache()` doc comment already promises for page RULES ("a revoked
   * permission that waits for a logout is not revoked"), extended to cover this global-permission
   * case too (OpenProject #936).
   *
   * @param groupId Group ID
   * @returns How many sessions were ended
   */
  async clearSessionsForGroup(groupId: string): Promise<number> {
    const members = await WIKI.db
      .select({ userId: userGroupsTable.userId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.groupId, groupId))
    if (members.length < 1) {
      return 0
    }
    const result = await WIKI.db.delete(sessionsTable).where(
      inArray(
        sessionsTable.userId,
        members.map((m) => m.userId)
      )
    )
    return result.rowCount ?? 0
  }

  /**
   * Replace the secret cookies are signed with, and end every session there is.
   *
   * The two halves do different work, and both are needed. Dropping the rows is what logs everybody
   * out **now**: a cookie whose session is gone identifies nothing, so the next request from every
   * browser — on every instance, since the rows are shared — starts a new, anonymous one. Rotating
   * the secret is what makes the cookies themselves worthless, and that takes effect immediately too:
   * `signer` above reads `WIKI.config.auth.secret` fresh on every sign/unsign call rather than a
   * value handed to @fastify/session/@fastify/cookie once at boot, so a still-running instance stops
   * validating old-secret-signed cookies AND stops minting new ones under the invalidated secret the
   * moment `reloadConfig` refreshes its config (`core/config.ts#subscribeToEvents`) — no restart
   * required, on this instance or any other. Task 589 / OpenProject #2172.
   *
   * The API key keypair is untouched: it carries its own passphrase (`models/apiKeys.ts`), so keys
   * already issued keep working.
   *
   * @returns How many sessions were ended, or null if the settings failed to save
   */
  async rotateSecret(): Promise<number | null> {
    const previousAuth = WIKI.config.auth
    WIKI.config.auth = { ...previousAuth, secret: crypto.randomBytes(32).toString('hex') }
    // -> Propagates as `reloadConfig`, so the other instances are holding the new secret the next
    //    time any of them restarts
    if (!(await WIKI.configSvc.saveToDb(['auth']))) {
      WIKI.config.auth = previousAuth
      return null
    }

    const result = await WIKI.db.delete(sessionsTable)
    const ended = result.rowCount ?? 0
    WIKI.logger.info(`Rotated the session secret and ended ${ended} session(s) [ OK ]`)
    return ended
  }
}

export const sessions = new Sessions()
