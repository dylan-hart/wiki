import { and, eq, inArray, sql } from 'drizzle-orm'
import { pages as pagesTable, tags as tagsTable, tree as treeTable } from '../db/schema.ts'
import type { AccessActor } from './groups.ts'
import type { SearchIndexablePage } from './search.ts'

export type Tag = Pick<typeof tagsTable.$inferSelect, 'tag' | 'usageCount'>

/** A candidate page for a tag rename/delete, before the caller has decided who may touch it. */
export interface TagPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string | null
}

/**
 * Tags
 *
 * A tag is not a row anybody creates: it exists because a page carries it, in `pages.tags`. The list
 * is therefore derived rather than stored, which is what keeps it from drifting out of step with the
 * pages after an edit, a delete or a restore.
 *
 * NOTE: the `tags` table in the schema is a leftover of an earlier design and is never written to.
 * Reading from it here would answer every request with an empty list.
 */
class Tags {
  /**
   * Every tag used by a page of this site, most used first
   *
   * @param siteId Site the pages belong to
   * @param limit Ceiling on how many distinct tags come back, most used first
   * @param actor Who is asking. Given one, the list is built only from the pages they may read —
   *              a tag is the name of something on a page, and the set of tags in use tells a
   *              reader what a wiki is about. Counted over readable pages too, so the numbers agree
   *              with what a search for the tag would return.
   */
  async getTags(
    siteId: string,
    { limit = 1000, actor }: { limit?: number; actor?: AccessActor } = {}
  ): Promise<Tag[]> {
    if (!actor) {
      const result = await WIKI.db.execute(sql`
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
      into account. Only tagged pages are read, and only their path, locale and tags.
    */
    const result = await WIKI.db.execute(sql`
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
      if (!WIKI.models.groups.checkAccess(actor, 'read:pages', page)) {
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
   * Every page of this site that currently carries `tag`, as candidates for a rename or delete.
   *
   * Deliberately returns every carrier regardless of who is asking — this is not the read-permission
   * filtered view `getTags` builds. The caller (`api/tags.ts`) still has to decide, per page, whether
   * THIS actor may act on it (`mayOnPage(req, 'manage:pages', ...)`) before doing anything with the
   * result; this just narrows "every page in the site" down to the ones that would actually change.
   */
  async pagesWithTag(siteId: string, tag: string): Promise<TagPageRef[]> {
    return WIKI.db
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
   * Rename a tag across a specific, already permission-filtered set of pages.
   *
   * An array-element rewrite of `pages.tags` — `array_replace`, wrapped in a `DISTINCT`/`array_agg` so
   * a page that already carries `newTag` ends up with one entry instead of two. This is also the whole
   * of what merging two tags is: renaming one of them to the other's name collapses them together on
   * every page that had both, the same as it does here for one.
   *
   * Does no access control of its own — `pageIds` is expected to already be the subset the caller
   * checked `manage:pages` against, one page at a time (see `pagesWithTag`'s doc comment). `tree.tags`
   * is kept in step alongside `pages.tags` since `models/tree.ts`'s tag-filtered browse reads from
   * there, not from `pages` — the same pairing `models/pages.ts#updatePage` maintains for a single-page
   * edit. Every page actually touched is handed to `WIKI.models.search.updated` off the same
   * `.returning()`, so the rename is reflected in search results without a separate reindex pass.
   *
   * @returns The rows actually updated
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
    const updated = await WIKI.db
      .update(pagesTable)
      .set({ tags: rewrite(pagesTable.tags), updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, pageIds)))
      .returning()
    if (updated.length > 0) {
      await WIKI.db
        .update(treeTable)
        .set({ tags: rewrite(treeTable.tags), updatedAt: sql`now()` })
        .where(
          inArray(
            treeTable.id,
            updated.map((page) => page.id)
          )
        )
      for (const page of updated) {
        await WIKI.models.search.updated(page)
      }
    }
    return updated
  }

  /**
   * Delete a tag from a specific, already permission-filtered set of pages.
   *
   * `array_remove` needs no dedup step the way rename's `array_replace` does — removing an element
   * never creates a collision. Otherwise the same contract as `renameTag`: no access control here,
   * `tree.tags` kept in step, and every touched page reindexed off the `.returning()` rows.
   *
   * @returns The rows actually updated
   */
  async deleteTag(siteId: string, tag: string, pageIds: string[]): Promise<SearchIndexablePage[]> {
    if (pageIds.length < 1) {
      return []
    }
    const updated = await WIKI.db
      .update(pagesTable)
      .set({ tags: sql`array_remove(${pagesTable.tags}, ${tag})`, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, pageIds)))
      .returning()
    if (updated.length > 0) {
      await WIKI.db
        .update(treeTable)
        .set({ tags: sql`array_remove(${treeTable.tags}, ${tag})`, updatedAt: sql`now()` })
        .where(
          inArray(
            treeTable.id,
            updated.map((page) => page.id)
          )
        )
      for (const page of updated) {
        await WIKI.models.search.updated(page)
      }
    }
    return updated
  }
}

export const tags = new Tags()
