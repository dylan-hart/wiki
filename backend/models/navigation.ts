import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { navigation as navigationTable, tree as treeTable } from '../db/schema.ts'
import { CustomError, decodeTreePath } from '../helpers/common.ts'
import type { TreeItemType } from './tree.ts'

export const NAVIGATION_MODES = [
  'inherit',
  'override',
  'overrideExact',
  'hide',
  'hideExact'
] as const
export type NavigationMode = (typeof NAVIGATION_MODES)[number]

export interface NavigationItem {
  id: string
  type: 'link' | 'header' | 'separator'
  label?: string
  icon?: string
  target?: string
  openInNewWindow?: boolean
  /** A link with children only: whether the sidebar shows its submenu already open. */
  expandByDefault?: boolean
  visibilityGroups?: string[]
  children?: NavigationItem[]
}

export interface UpdateNavigationResult {
  navigationMode: NavigationMode
  navigationId: string | null
}

/** One tree entry whose navigation mode overrides what it would otherwise inherit. */
export interface NavigationOverride {
  id: string
  type: TreeItemType
  folderPath: string
  fileName: string
  title: string
  locale: string
  navigationMode: NavigationMode
  navigationId: string | null
}

/** An item is visible when it names no group, or names one the viewer belongs to. */
function isVisibleTo(item: NavigationItem, userGroups: string[]): boolean {
  const groups = item.visibilityGroups ?? []
  return groups.length < 1 || groups.some((g) => userGroups.includes(g))
}

/**
 * Navigation model
 *
 * A navigation menu is a row of `items` keyed by its own id: a tree entry that overrides the menu
 * below it, addressed by that entry's own id, or — for the site-wide menu every page falls back to —
 * a row identified not by id (a real random uuid, meaningless on its own) but by the `(siteId,
 * locale)` pair it belongs to, since a site with more than one active locale needs one such menu per
 * locale. The home page of a given locale edits that locale's site menu rather than one of its own.
 *
 * Which menu a page gets is decided when the mode is saved rather than when the page is rendered:
 * every tree entry carries the resolved `navigationId` — the menu row's real id either way — so
 * drawing a sidebar is one lookup.
 */
class Navigation {
  /**
   * The items of one menu.
   *
   * @param id Menu id — a tree entry id, or a site-wide menu's own row id (see `ensureSiteNav`)
   * @param userGroups Groups the viewer belongs to. Items limited to other groups are dropped, at both
   *                   levels, unless `unfiltered` is set.
   * @param unfiltered Return every item regardless of visibility, which is what editing one needs —
   *                   an editor that could not see an item would drop it on the next save.
   */
  async getNav(
    id: string,
    { userGroups = [], unfiltered = false }: { userGroups?: string[]; unfiltered?: boolean } = {}
  ): Promise<NavigationItem[]> {
    const rows = await WIKI.db
      .select({ items: navigationTable.items })
      .from(navigationTable)
      .where(eq(navigationTable.id, id))
      .limit(1)

    const items = (rows[0]?.items ?? []) as NavigationItem[]
    if (unfiltered) {
      return items
    }
    return items
      .filter((item) => isVisibleTo(item, userGroups))
      .map((item) =>
        item.children?.length
          ? { ...item, children: item.children.filter((c) => isVisibleTo(c, userGroups)) }
          : item
      )
  }

  /**
   * The menu one locale of the site as a whole uses, which is what every page in that locale inherits
   * by default. Returns its row id — never the site id, and not stable to guess at, since it is a
   * plain `defaultRandom()` uuid — so a caller always gets this from here rather than assuming it.
   *
   * Created empty on demand: a site made before this row existed, a locale activated since, or a menu
   * that was never edited, has nothing stored, and an absent menu is an empty one rather than an
   * error. Idempotent: identified by `(siteId, locale)`, not by id, so calling it again for the same
   * site and locale returns the same row instead of creating a second one.
   */
  async ensureSiteNav(siteId: string, locale: string): Promise<string> {
    const inserted = await WIKI.db
      .insert(navigationTable)
      .values({ siteId, locale, items: [] })
      .onConflictDoNothing({ target: [navigationTable.siteId, navigationTable.locale] })
      .returning({ id: navigationTable.id })
    if (inserted[0]) {
      return inserted[0].id
    }
    const existing = await WIKI.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(and(eq(navigationTable.siteId, siteId), eq(navigationTable.locale, locale)))
      .limit(1)
    return existing[0]!.id
  }

  /**
   * Drop the menus belonging to tree entries that no longer exist.
   *
   * A menu is keyed by the id of the entry that owns it, so deleting a page or a folder would
   * otherwise leave its menu behind with nothing able to reach it. A site-wide menu is identified by
   * `(siteId, locale)` rather than by belonging to a tree entry, so it is not at risk here.
   *
   * @param ids Tree entry ids being removed
   */
  async deleteNavForEntries(ids: string[]): Promise<void> {
    if (ids.length < 1) {
      return
    }
    await WIKI.db.delete(navigationTable).where(inArray(navigationTable.id, ids))
  }

  /**
   * Every tree entry in a site whose navigation mode overrides what it would otherwise inherit.
   *
   * A flat scan against `tree`, not a walk of the hierarchy: `navigationMode` and `folderPath` are
   * both indexed, so filtering on the former and ordering by the latter is a cheap indexed scan
   * rather than something that needs `ancestorNavId`'s ltree-ancestry logic, which answers a
   * different question (the single nearest override above one entry, not every entry that overrides).
   *
   * @param locale Restrict to entries in this locale. Every locale when omitted.
   */
  async listOverrides(
    siteId: string,
    { locale }: { locale?: string } = {}
  ): Promise<NavigationOverride[]> {
    const conditions = [eq(treeTable.siteId, siteId), ne(treeTable.navigationMode, 'inherit')]
    if (locale) {
      conditions.push(eq(treeTable.locale, locale))
    }

    const rows = await WIKI.db
      .select({
        id: treeTable.id,
        type: treeTable.type,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        title: treeTable.title,
        locale: treeTable.locale,
        navigationMode: treeTable.navigationMode,
        navigationId: treeTable.navigationId
      })
      .from(treeTable)
      .where(and(...conditions))
      .orderBy(asc(treeTable.folderPath), asc(treeTable.fileName))

    return rows.map((row) => ({
      ...row,
      folderPath: decodeTreePath(row.folderPath ?? '') ?? ''
    }))
  }

  /**
   * Write a menu's items directly, addressed by the id of the row that already holds it.
   *
   * No page or mode resolution, unlike `updateNavigation` — the caller already knows which row it
   * means, because it read the id off the thing it is editing: a site-wide default's own row id (from
   * `ensureSiteNav`, or `GET /sites/:siteId/navigation/default` for a caller with no db access of its
   * own) or an override's `navigationId` from `listOverrides`. That is what the admin-launched menu
   * editor (Task 433) saves against, as opposed to the page-context editor, which still goes through
   * `updateNavigation` so that saving from an inheriting page can repoint at the ancestor it inherits
   * from.
   *
   * @param navId The row to write to — a site-wide default's own id, or a tree entry id belonging to
   *              this site
   */
  async setNavItems(siteId: string, navId: string, items: NavigationItem[]): Promise<void> {
    const existing = await WIKI.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, navId), eq(navigationTable.siteId, siteId)))
      .limit(1)
    if (existing.length < 1) {
      // -> Refuse a navId that names neither an existing menu row of this site nor one of its own
      //    tree entries, rather than silently creating a floating navigation row nothing else ever
      //    reaches
      await this.getEntry(siteId, navId)
    }

    await WIKI.db
      .insert(navigationTable)
      .values({ id: navId, siteId, items })
      .onConflictDoUpdate({ target: navigationTable.id, set: { items } })
  }

  /** The tree entry a navigation change is addressed to. */
  private async getEntry(siteId: string, pageId: string) {
    const entries = await WIKI.db
      .select()
      .from(treeTable)
      .where(and(eq(treeTable.id, pageId), eq(treeTable.siteId, siteId)))
      .limit(1)
    const entry = entries[0]
    if (!entry) {
      throw new CustomError('navInvalidPage', 'This page does not exist.', 404)
    }
    return entry
  }

  /**
   * The menu a tree entry falls back to: the nearest ancestor that overrides or hides, or the
   * site-wide menu for its locale when nothing above it does either.
   *
   * @param siteId Site the entry belongs to, since paths are only unique within one
   * @param locale Locale the entry belongs to — an ancestor override in a different locale that
   *               happens to share the same path is not this entry's ancestor
   * @param folderPath Encoded ltree path of the folder holding the entry, empty at the site root
   */
  private async ancestorNavId(
    siteId: string,
    locale: string,
    folderPath: string
  ): Promise<string | null> {
    if (!folderPath) {
      return this.ensureSiteNav(siteId, locale)
    }
    const result = await WIKI.db.execute(sql`
      SELECT "navigationId"
      FROM tree
      WHERE "siteId" = ${siteId}
        AND "locale" = ${locale}
        AND ("folderPath" || "fileName") @> ${folderPath}::ltree
        AND "navigationMode" IN ('override', 'hide')
      ORDER BY nlevel("folderPath" || "fileName") DESC
      LIMIT 1
    `)
    const rows = (result.rows ?? result) as any[]
    if (rows.length > 0) {
      return rows[0].navigationId ?? null
    }
    return this.ensureSiteNav(siteId, locale)
  }

  /**
   * The menu a page inherits — the one its sidebar shows while its own mode is `inherit`.
   *
   * `navigationId` on the entry already answers this for a page that IS inheriting, but only for one:
   * the navigation editor asks before anything is saved, so that a page can edit the menu it shows
   * without being opened on the ancestor that owns it, and so that it can tell there is one to edit.
   *
   * Null when the nearest ancestor hides the sidebar, which leaves nothing to inherit.
   */
  async inheritedNavId(siteId: string, pageId: string): Promise<string | null> {
    const entry = await this.getEntry(siteId, pageId)
    return this.ancestorNavId(siteId, entry.locale, entry.folderPath ?? '')
  }

  /**
   * Set how a page decides its sidebar, and optionally the menu itself.
   *
   * Two things move here. The entry records its own mode and the menu it resolves to, and — when the
   * change alters what descendants inherit — every entry below it that is still on `inherit` is
   * repointed, stopping at any that overrides or hides in between.
   *
   * @param items When given, the menu the mode resolves to, replacing whatever was there — this
   *              entry's own, or the one it inherits when the mode is `inherit`
   */
  async updateNavigation({
    siteId,
    pageId,
    mode,
    items
  }: {
    siteId: string
    pageId: string
    mode: NavigationMode
    items?: NavigationItem[]
  }): Promise<UpdateNavigationResult> {
    const entry = await this.getEntry(siteId, pageId)

    // -> Whatever this change resolves to, `inherit` ultimately falls back to this entry's locale's
    //    site menu, and a site created before that row existed — or a locale activated since — does
    //    not have one yet
    const siteNavId = await this.ensureSiteNav(siteId, entry.locale)

    const folderPath = entry.folderPath ?? ''
    // -> The home page at the root edits its locale's site-wide menu rather than one of its own, which
    //    is what makes it the menu every other page in that locale inherits
    const isSiteRoot = folderPath === '' && entry.fileName === 'home'
    const ownNavId = isSiteRoot ? siteNavId : entry.id
    const fullPath = folderPath ? `${folderPath}.${entry.fileName}` : entry.fileName

    const ancestorId = await this.ancestorNavId(siteId, entry.locale, folderPath)

    if (items) {
      /*
        Which menu the items belong to is the mode's answer, not the entry's: a page that inherits
        shows a menu belonging to an ancestor, so editing the sidebar from that page edits THAT menu
        rather than starting one of its own that nothing would point at. For the root home page the two
        are the same id — the site-wide menu is what it inherits and what it owns.
      */
      const targetNavId = mode === 'inherit' ? ancestorId : ownNavId
      if (!targetNavId) {
        throw new CustomError(
          'navNoInheritedMenu',
          'This page inherits a hidden sidebar, so there is no menu to save items to.',
          400
        )
      }
      await WIKI.db
        .insert(navigationTable)
        .values({ id: targetNavId, siteId, items })
        .onConflictDoUpdate({ target: navigationTable.id, set: { items } })
    }

    // -> A mode that stops applying below this entry hands its descendants back to the ancestor
    const wasCascading = ['override', 'hide'].includes(entry.navigationMode)

    let navId: string | null = null
    let cascadeTo: string | null | undefined

    switch (mode) {
      case 'inherit': {
        navId = ancestorId
        if (wasCascading) {
          cascadeTo = ancestorId
        }
        break
      }
      case 'override': {
        navId = ownNavId
        cascadeTo = ownNavId
        break
      }
      case 'overrideExact': {
        navId = ownNavId
        if (wasCascading) {
          cascadeTo = ancestorId
        }
        break
      }
      case 'hide': {
        navId = null
        cascadeTo = null
        break
      }
      case 'hideExact': {
        navId = null
        if (wasCascading) {
          cascadeTo = ancestorId
        }
        break
      }
    }

    await WIKI.db
      .update(treeTable)
      .set({ navigationMode: mode, navigationId: navId })
      .where(eq(treeTable.id, entry.id))

    if (cascadeTo !== undefined) {
      // -> Everything below that still inherits, except what sits under a nearer override or hide,
      //    which owns its own subtree
      await WIKI.db.execute(sql`
        UPDATE tree tt
        SET "navigationId" = ${cascadeTo}
        WHERE tt."siteId" = ${siteId}
          AND tt.tree IN ('page', 'folder')
          AND tt."folderPath" <@ ${fullPath}::ltree
          AND tt."navigationMode" = 'inherit'
          AND NOT EXISTS (
            SELECT 1
            FROM tree tc
            WHERE tc."siteId" = ${siteId}
              AND tc.tree IN ('page', 'folder')
              AND tc."folderPath" <@ ${fullPath}::ltree
              AND (tc."folderPath" || tc."fileName") @> tt."folderPath"
              AND tc."navigationMode" IN ('override', 'hide')
          )
      `)
    }

    return { navigationMode: mode, navigationId: navId }
  }
}

export const navigation = new Navigation()
