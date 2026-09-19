import crypto from 'node:crypto'
import { eq, inArray, lt, sql } from 'drizzle-orm'
import { sessions as sessionsTable, userGroups as userGroupsTable } from '../db/schema.ts'
import type { WikiDbOrTx } from '../core/db.ts'

class Sessions {
  async get(id: string): Promise<any> {
    const res = await CARDINAL.db.select().from(sessionsTable).where(eq(sessionsTable.id, id))
    return res?.[0]?.data ?? null
  }

  async set(id: string, data: any): Promise<void> {
    await CARDINAL.db
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

  async destroy(id: string) {
    return CARDINAL.db.delete(sessionsTable).where(eq(sessionsTable.id, id))
  }

  /**
   * `session.groups`/`session.permissions` are snapshots taken at login (`models/users.ts`'s
   * `updateSession`) and otherwise live up to the 30-day cookie age, so dropping the row is what
   * makes a deactivation or a membership change bite on the browser's next request rather than at
   * its next login.
   */
  async clearSessionsFromUser(userId: string, db: WikiDbOrTx = CARDINAL.db) {
    return db.delete(sessionsTable).where(eq(sessionsTable.userId, userId))
  }

  /**
   * The group-wide counterpart to `clearSessionsFromUser()`: a group's global `permissions` column
   * is flattened onto `session.permissions` at login too, so a permission revoked there is just as
   * stale in every current member's open session.
   */
  async clearSessionsForGroup(groupId: string): Promise<number> {
    const members = await CARDINAL.db
      .select({ userId: userGroupsTable.userId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.groupId, groupId))
    if (members.length < 1) {
      return 0
    }
    const result = await CARDINAL.db.delete(sessionsTable).where(
      inArray(
        sessionsTable.userId,
        members.map((m) => m.userId)
      )
    )
    return result.rowCount ?? 0
  }

  /**
   * Both halves are needed. Dropping the rows logs everybody out **now** — on every instance, since
   * the rows are shared — because a cookie whose session is gone identifies nothing. Rotating the
   * secret is what makes the cookies themselves worthless, and it needs no restart either:
   * @fastify/session and @fastify/cookie are handed `helpers/authSecretSigner.ts`, which reads
   * `CARDINAL.config.auth.secret` at call time rather than capturing it at plugin registration.
   *
   * The API key keypair is untouched: it carries its own passphrase (`models/apiKeys.ts`), so keys
   * already issued keep working.
   */
  async rotateSecret(): Promise<number | null> {
    const previousAuth = CARDINAL.config.auth
    CARDINAL.config.auth = { ...previousAuth, secret: crypto.randomBytes(32).toString('hex') }
    // -> Propagates as `reloadConfig`, so every other instance is holding the new secret
    //    immediately
    if (!(await CARDINAL.configSvc.saveToDb(['auth']))) {
      CARDINAL.config.auth = previousAuth
      return null
    }

    const result = await CARDINAL.db.delete(sessionsTable)
    const ended = result.rowCount ?? 0
    CARDINAL.logger.info('session', 'rotated the session secret', { ended })
    return ended
  }

  /**
   * The window matches `core/http/session.ts`'s `cookie.maxAge`. `@fastify/session` only does
   * cookie-side `expires` bookkeeping and never calls `store.destroy` on a stale row, so without
   * this the table grows without bound while holding `email`, `name` and the flattened permission
   * list in its `data` jsonb.
   *
   * `updatedAt`, not `createdAt`: `set()` bumps it on every touch, so this is 30 days of
   * *inactivity*, matching how the cookie expires client-side rather than cutting off an active
   * session for being old.
   */
  async purgeExpiredSessions(): Promise<number> {
    const result = await CARDINAL.db
      .delete(sessionsTable)
      .where(lt(sessionsTable.updatedAt, sql`now() - interval '30 days'`))
    return result.rowCount ?? 0
  }
}

export const sessions = new Sessions()

type SessionStoreCallback = (err: any, result?: any) => void

/**
 * Takes a thunk rather than an already-started promise, so a synchronous throw from the model is
 * reported through the callback like a rejection instead of escaping the wrapper.
 */
async function settle(op: () => Promise<any>, clb: SessionStoreCallback): Promise<void> {
  try {
    clb(null, await op())
  } catch (err: any) {
    clb(err, null)
  }
}

/**
 * The `store` @fastify/session is registered with (`core/http/session.ts`), adapting its
 * callback-based interface onto this promise-based model.
 *
 * Reads `CARDINAL.models.sessions` rather than the `sessions` instance above: the store is built
 * once at registration, and everything else in the request path goes through the model registry.
 */
export function sessionStoreAdapter() {
  return {
    get: (sessionId: string, clb: SessionStoreCallback) =>
      settle(() => CARDINAL.models.sessions.get(sessionId), clb),
    set: (sessionId: string, sessionData: any, clb: SessionStoreCallback) =>
      settle(() => CARDINAL.models.sessions.set(sessionId, sessionData), clb),
    destroy: (sessionId: string, clb: SessionStoreCallback) =>
      settle(() => CARDINAL.models.sessions.destroy(sessionId), clb)
  }
}
