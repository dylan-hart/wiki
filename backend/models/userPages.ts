import { and, asc, desc, eq, notInArray, sql } from 'drizzle-orm'
import { pages as pagesTable, userPages as userPagesTable } from '../db/schema.ts'
import type { AccessActor } from './groups.ts'

export type UserPageKind = 'recent' | 'favorite' | 'pinned'

export type UserPageMarkKind = Exclude<UserPageKind, 'recent'>

export const MAX_RECENTS = 25

export interface UserPageEntry {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  updatedAt: Date
  kind: UserPageKind
  /** Set for pins only. */
  position: number | null
  /** When this row was created, or for a recent, last visited. */
  touchedAt: Date
}

class UserPages {
  async touchRecent({
    siteId,
    userId,
    pageId,
    cap = MAX_RECENTS
  }: {
    siteId: string
    userId: string
    pageId: string
    cap?: number
  }): Promise<void> {
    await CARDINAL.db
      .insert(userPagesTable)
      .values({ siteId, userId, pageId, kind: 'recent' })
      .onConflictDoUpdate({
        target: [userPagesTable.userId, userPagesTable.pageId, userPagesTable.kind],
        set: { updatedAt: sql`now()` }
      })

    const scope = and(
      eq(userPagesTable.userId, userId),
      eq(userPagesTable.siteId, siteId),
      eq(userPagesTable.kind, 'recent')
    )
    const keep = CARDINAL.db
      .select({ id: userPagesTable.id })
      .from(userPagesTable)
      .where(scope)
      .orderBy(desc(userPagesTable.updatedAt), desc(userPagesTable.id))
      .limit(Math.max(1, cap))
    await CARDINAL.db.delete(userPagesTable).where(and(scope, notInArray(userPagesTable.id, keep)))
  }

  async add({
    siteId,
    userId,
    pageId,
    kind
  }: {
    siteId: string
    userId: string
    pageId: string
    kind: UserPageMarkKind
  }): Promise<void> {
    const position =
      kind === 'pinned'
        ? sql<number>`(SELECT COALESCE(MAX("position"), -1) + 1 FROM ${userPagesTable} WHERE "userId" = ${userId} AND "siteId" = ${siteId} AND "kind" = 'pinned')`
        : null
    await CARDINAL.db
      .insert(userPagesTable)
      .values({ siteId, userId, pageId, kind, position })
      .onConflictDoNothing({
        target: [userPagesTable.userId, userPagesTable.pageId, userPagesTable.kind]
      })
  }

  async remove({
    userId,
    pageId,
    kind
  }: {
    userId: string
    pageId: string
    kind: UserPageKind
  }): Promise<boolean> {
    const rows = await CARDINAL.db
      .delete(userPagesTable)
      .where(
        and(
          eq(userPagesTable.userId, userId),
          eq(userPagesTable.pageId, pageId),
          eq(userPagesTable.kind, kind)
        )
      )
      .returning({ id: userPagesTable.id })
    return rows.length > 0
  }

  /**
   * @param actor Who is asking, as the request presents itself (`groups.actorForRequest`), not
   *   `userId`'s own full membership: an API key acting for the user carries its scope, its
   *   classification allow-set and its site pin, and a page any of those shuts out must not be
   *   listed through the key.
   */
  async list({
    siteId,
    userId,
    kind,
    actor
  }: {
    siteId: string
    userId: string
    kind: UserPageKind
    actor: AccessActor
  }): Promise<UserPageEntry[]> {
    const order =
      kind === 'pinned'
        ? [asc(userPagesTable.position), asc(userPagesTable.createdAt)]
        : [desc(kind === 'recent' ? userPagesTable.updatedAt : userPagesTable.createdAt)]
    const rows = await CARDINAL.db
      .select({
        pageId: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        title: pagesTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        updatedAt: pagesTable.updatedAt,
        kind: userPagesTable.kind,
        position: userPagesTable.position,
        touchedAt: userPagesTable.updatedAt
      })
      .from(userPagesTable)
      .innerJoin(pagesTable, eq(pagesTable.id, userPagesTable.pageId))
      .where(
        and(
          eq(userPagesTable.userId, userId),
          eq(userPagesTable.siteId, siteId),
          eq(pagesTable.siteId, siteId),
          eq(userPagesTable.kind, kind)
        )
      )
      .orderBy(...order)
    if (rows.length < 1) {
      return []
    }
    return rows
      .filter((row) =>
        CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path: row.path,
          siteId,
          locale: row.locale,
          tags: row.tags ?? [],
          classification: row.classification ?? null
        })
      )
      .map(({ tags: _tags, classification: _classification, ...entry }) => entry)
  }
}

export const userPages = new UserPages()
