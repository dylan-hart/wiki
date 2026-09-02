import crypto from 'node:crypto'
import { eq, inArray, lt, sql } from 'drizzle-orm'
import { sessions as sessionsTable, userGroups as userGroupsTable } from '../db/schema.ts'
import type { WikiDbOrTx } from '../core/db.ts'

/**
 * Sessions model
 */
class Sessions {
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
  async clearSessionsFromUser(userId: string, db: WikiDbOrTx = WIKI.db) {
    return db.delete(sessionsTable).where(eq(sessionsTable.userId, userId))
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
   * @fastify/session and @fastify/cookie are handed `helpers/authSecretSigner.ts` (`index.ts`), which
   * reads `WIKI.config.auth.secret` at call time rather than a value captured once at plugin
   * registration, so this instance starts signing and verifying against the new secret on its very
   * next request, no restart required. Verified under a real two-instance HA setup for task 589 (back
   * when the secret WAS captured by value — OpenProject #2172 closed that gap): every other
   * still-running instance picks up the rotated secret the same way, the moment `WIKI.config` is
   * replaced in response to the `reloadConfig` event this call's `saveToDb()` fans out.
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

  /**
   * Drop rows past the cookie's 30-day window (`index.ts`'s `fastifySession` `cookie.maxAge`).
   *
   * `@fastify/session` only does cookie-side `expires` bookkeeping -- it never calls `store.destroy`
   * on a stale row, so once a cookie stops being presented its row is never revisited on its own.
   * Left alone that makes `sessions` an unbounded, monotonically growing table that is SELECTed by
   * primary key on every authenticated request and whose `data` jsonb holds `email`, `name` and the
   * flattened permission list. Mirrors `rateLimits.ts#purgeStale()`'s shape exactly.
   *
   * `updatedAt`, not `createdAt`, is the right column: `set()` bumps it on every touch, so this is 30
   * days of *inactivity*, matching how the cookie itself actually expires client-side rather than
   * purging an active session early just because it is old.
   *
   * @returns How many rows were dropped
   */
  async purgeExpiredSessions(): Promise<number> {
    const result = await WIKI.db
      .delete(sessionsTable)
      .where(lt(sessionsTable.updatedAt, sql`now() - interval '30 days'`))
    return result.rowCount ?? 0
  }
}

export const sessions = new Sessions()

/** @fastify/session's node-style store callback: `(err, result)`. */
type SessionStoreCallback = (err: any, result?: any) => void

/**
 * Runs one store operation and reports it back through @fastify/session's callback contract.
 *
 * A thunk rather than an already-started promise, so a synchronous throw from the model is reported
 * the same way a rejection is instead of escaping the wrapper.
 */
async function settle(op: () => Promise<any>, clb: SessionStoreCallback): Promise<void> {
  try {
    clb(null, await op())
  } catch (err: any) {
    clb(err, null)
  }
}

/**
 * The `store` @fastify/session is registered with (`core/http/session.ts`).
 *
 * @fastify/session's store interface is callback-based while this model is promise-based, so each of
 * the three operations needs the same `try { clb(null, await …) } catch (err) { clb(err, null) }`
 * wrapper — written out three times inline in `index.ts` until CORE-F12 collapsed them onto one
 * `settle()` here, beside the methods they adapt.
 *
 * Reads `WIKI.models.sessions` rather than the `sessions` instance above, exactly as the inline
 * version did: the store is built once at registration, and everything else in the request path goes
 * through the model registry.
 */
export function sessionStoreAdapter() {
  return {
    get: (sessionId: string, clb: SessionStoreCallback) =>
      settle(() => WIKI.models.sessions.get(sessionId), clb),
    set: (sessionId: string, sessionData: any, clb: SessionStoreCallback) =>
      settle(() => WIKI.models.sessions.set(sessionId, sessionData), clb),
    destroy: (sessionId: string, clb: SessionStoreCallback) =>
      settle(() => WIKI.models.sessions.destroy(sessionId), clb)
  }
}
