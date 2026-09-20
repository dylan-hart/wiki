import { and, eq, inArray, sql } from 'drizzle-orm'
import { pages as pagesTable, tags as tagsTable, tree as treeTable } from '../db/schema.ts'
import type { AccessActor } from './groups.ts'
import type { SearchIndexablePage } from './search.ts'

export type Tag = Pick<typeof tagsTable.$inferSelect, 'tag' | 'usageCount'>

export interface TagPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string | null
}

/**
 * A tag is not a row anybody creates: it exists because a page carries it, in `pages.tags`, so the
 * list is derived rather than stored and cannot drift out of step with the pages.
 *
 * The `tags` table is never written to — reading from it here would answer every request with an
 * empty list.
 */
class Tags {
  /**
   * @param actor Given one, only pages they may read are counted — the set of tags in use tells a
   *              reader what a wiki is about, and counting over the same pages keeps the numbers
   *              agreeing with what a search for the tag would return.
   */
  async getTags(
    siteId: string,
    { limit = 1000, actor }: { limit?: number; actor?: AccessActor } = {}
  ): Promise<Tag[]> {
    if (!actor) {
      const result = await CARDINAL.db.execute(sql`
        SELECT tag, COUNT(*)::int AS "usageCount"
        FROM pages, unnest(tags) AS tag
        WHERE "siteId" = ${siteId}
        GROUP BY tag
        ORDER BY COUNT(*) DESC, tag ASC
        LIMIT ${limit}
      `)
      return ((result.rows ?? result) as any[]).map((row) => ({
        tag: row.tag as string,
        usageCount: row.usageCount as number
      }))
    }

    /*
      Aggregated here rather than in postgres, because which pages count depends on the page rules and
      a rule can be a regular expression or a set of tags — neither of which a `GROUP BY` could take
      into account.
    */
    const result = await CARDINAL.db.execute(sql`
      SELECT path, locale, tags, classification
      FROM pages
      WHERE "siteId" = ${siteId} AND array_length(tags, 1) > 0
    `)
    const counts = new Map<string, number>()
    for (const row of (result.rows ?? result) as any[]) {
      const page = {
        path: row.path as string,
        locale: row.locale as string,
        siteId,
        tags: (row.tags ?? []) as string[],
        classification: (row.classification as string | null) ?? null
      }
      if (!CARDINAL.models.groups.checkAccess(actor, 'read:pages', page)) {
        continue
      }
      for (const tag of page.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([tag, usageCount]) => ({ tag, usageCount }))
      .sort((a, b) => b.usageCount - a.usageCount || a.tag.localeCompare(b.tag))
      .slice(0, limit)
  }

  /**
   * Ranked by recent activity rather than `getTags`'s lifetime usage: a wiki whose early,
   * now-abandoned content carries the most tags overall should not crowd out what people are
   * writing about lately. `getTags` keeps the all-time ranking the tag-edit autocomplete and the
   * tag-browse page want.
   *
   * @param actor Given one, only pages they may read are counted, as in `getTags`.
   */
  async getPopularTags(
    siteId: string,
    { limit = 10, days = 60, actor }: { limit?: number; days?: number; actor?: AccessActor } = {}
  ): Promise<Tag[]> {
    if (!actor) {
      const result = await CARDINAL.db.execute(sql`
        SELECT tag, COUNT(*)::int AS "usageCount"
        FROM pages, unnest(tags) AS tag
        WHERE "siteId" = ${siteId}
          AND GREATEST("createdAt", "updatedAt") >= now() - (${days} * interval '1 day')
        GROUP BY tag
        ORDER BY COUNT(*) DESC, tag ASC
        LIMIT ${limit}
      `)
      return ((result.rows ?? result) as any[]).map((row) => ({
        tag: row.tag as string,
        usageCount: row.usageCount as number
      }))
    }

    // See `getTags`'s doc comment for why this is aggregated here rather than in postgres.
    const result = await CARDINAL.db.execute(sql`
      SELECT path, locale, tags, classification
      FROM pages
      WHERE "siteId" = ${siteId} AND array_length(tags, 1) > 0
        AND GREATEST("createdAt", "updatedAt") >= now() - (${days} * interval '1 day')
    `)
    const counts = new Map<string, number>()
    for (const row of (result.rows ?? result) as any[]) {
      const page = {
        path: row.path as string,
        locale: row.locale as string,
        siteId,
        tags: (row.tags ?? []) as string[],
        classification: (row.classification as string | null) ?? null
      }
      if (!CARDINAL.models.groups.checkAccess(actor, 'read:pages', page)) {
        continue
      }
      for (const tag of page.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([tag, usageCount]) => ({ tag, usageCount }))
      .sort((a, b) => b.usageCount - a.usageCount || a.tag.localeCompare(b.tag))
      .slice(0, limit)
  }

  /**
   * Returns every carrier regardless of who is asking — unlike `getTags`, nothing here is
   * permission-filtered. The caller still has to check `manage:pages` per page before acting on the
   * result.
   */
  async pagesWithTag(siteId: string, tag: string): Promise<TagPageRef[]> {
    return CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), sql`${pagesTable.tags} @> ${sql.param([tag])}`))
  }

  /**
   * The `DISTINCT`/`array_agg` wrapper around `array_replace` is what keeps a page that already
   * carries `newTag` from ending up with two entries. Merging two tags is this same operation:
   * renaming one to the other's name collapses them on every page that had both.
   *
   * No access control of its own — `pageIds` must already be the subset the caller checked
   * `manage:pages` against. `tree.tags` is kept in step because `models/tree.ts`'s tag-filtered
   * browse reads from there, not from `pages`.
   */
  async renameTag(
    siteId: string,
    oldTag: string,
    newTag: string,
    pageIds: string[]
  ): Promise<SearchIndexablePage[]> {
    if (pageIds.length < 1 || oldTag === newTag) {
      return []
    }
    const rewrite = (column: typeof pagesTable.tags | typeof treeTable.tags) => sql`(
      SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), ARRAY[]::text[])
      FROM unnest(array_replace(${column}, ${oldTag}, ${newTag})) AS t
    )`
    const updated = await CARDINAL.db
      .update(pagesTable)
      .set({ tags: rewrite(pagesTable.tags), updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, pageIds)))
      .returning()
    if (updated.length > 0) {
      await CARDINAL.db
        .update(treeTable)
        .set({ tags: rewrite(treeTable.tags), updatedAt: sql`now()` })
        .where(
          inArray(
            treeTable.id,
            updated.map((page) => page.id)
          )
        )
      for (const page of updated) {
        await CARDINAL.models.search.updated(page)
      }
    }
    return updated
  }

  /**
   * `array_remove` needs no dedup step the way `renameTag`'s `array_replace` does — removing an
   * element never creates a collision. Same contract otherwise: no access control here.
   */
  async deleteTag(siteId: string, tag: string, pageIds: string[]): Promise<SearchIndexablePage[]> {
    if (pageIds.length < 1) {
      return []
    }
    const updated = await CARDINAL.db
      .update(pagesTable)
      .set({ tags: sql`array_remove(${pagesTable.tags}, ${tag})`, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, pageIds)))
      .returning()
    if (updated.length > 0) {
      await CARDINAL.db
        .update(treeTable)
        .set({ tags: sql`array_remove(${treeTable.tags}, ${tag})`, updatedAt: sql`now()` })
        .where(
          inArray(
            treeTable.id,
            updated.map((page) => page.id)
          )
        )
      for (const page of updated) {
        await CARDINAL.models.search.updated(page)
      }
    }
    return updated
  }
}

export const tags = new Tags()
