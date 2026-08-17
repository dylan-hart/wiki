import { and, asc, eq, exists, inArray, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  navigation as navigationTable,
  pages as pagesTable,
  tree as treeTable
} from '../db/schema.ts'
import { CustomError, decodeTreePath } from '../helpers/common.ts'
import { MAX_DEPTH, compareFoldersFirst, pageIsVisible } from './tree.ts'
import type { TreeItemType } from './tree.ts'

export const NAVIGATION_MODES = [
  'inherit',
  'override',
  'overrideExact',
  'hide',
  'hideExact'
] as const
export type NavigationMode = (typeof NAVIGATION_MODES)[number]

/**
 * Where a navigation row's items come from -- `navigation.mode` in the schema. `static` (the
 * default, and the only value any row has ever had) is hand-authored items exactly as `getNav` /
 * `setNavItems` already work; `auto` and `mixed` name the tree-walk modes a later task in this
 * feature adds a resolver for. Nothing in this file produces `auto` or `mixed` yet.
 */
export const NAVIGATION_SOURCE_MODES = ['static', 'auto', 'mixed'] as const
export type NavigationSourceMode = (typeof NAVIGATION_SOURCE_MODES)[number]

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
  /**
   * The resolved navigation row's own `mode` (static/auto/mixed) -- known here as a type so a later
   * task can start returning it without widening this interface again, but `updateNavigation` never
   * touches `navigation.mode`, so this task never sets it.
   */
  mode?: NavigationSourceMode
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
 * A navigation menu is a row of `items` keyed by the id of whatever it belongs to: a tree entry that
 * overrides the menu below it, or — for the site-wide menu every page falls back to — the site's own
 * id. That double use of the key is why the id alone is enough to fetch a menu, and why the home page
 * edits the site menu rather than one of its own.
 *
 * Which menu a page gets is decided when the mode is saved rather than when the page is rendered:
 * every tree entry carries the resolved `navigationId`, so drawing a sidebar is one lookup.
 */
class Navigation {
  /**
   * The items of one menu.
   *
   * @param id Menu id — a tree entry id, or a site id for the site-wide menu
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
   * The menu the site as a whole uses, which is the one every page inherits by default.
   *
   * Created empty on demand: a site made before this row existed, or one whose menu was never edited,
   * has nothing stored, and an absent menu is an empty one rather than an error.
   *
   * Deliberately does not set `mode` -- the schema default (`static`) is what every row created here
   * should get, so a row this creates behaves exactly as it did before `mode` existed.
   */
  async ensureSiteNav(siteId: string): Promise<void> {
    await WIKI.db
      .insert(navigationTable)
      .values({ id: siteId, siteId, items: [] })
      .onConflictDoNothing()
  }

  /**
   * Drop the menus belonging to tree entries that no longer exist.
   *
   * A menu is keyed by the id of the entry that owns it, so deleting a page or a folder would
   * otherwise leave its menu behind with nothing able to reach it. The site's own menu is keyed by the
   * site id and is never a tree entry, so it is not at risk here.
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
   * Build a menu by walking the tree instead of reading a hand-authored `items` row — the `auto` /
   * `mixed` navigation source modes this feature adds. Not wired into `getNav` yet; a later task in
   * this feature is what calls this from the resolution path.
   *
   * Queries `tree`/`pages` under `rootFolderPath` the same way `tree.browse()` lists a folder: joined
   * on `pages` for `isBrowsable`/`publishState`/`icon`, a folder with no visible descendant page
   * dropped via the same `EXISTS` pattern (`holdsVisiblePages`), `asset` entries never considered, and
   * ordered by the same folders-then-title comparator `browse()` uses (`compareFoldersFirst`, factored
   * out of `tree.ts` for exactly this reuse).
   *
   * Sub-boundary rule, per the feature brief: an entry whose own `navigationMode` is `hide` or
   * `hideExact` is dropped from the walk outright — for the recursive `hide` that silently drops
   * everything below it too, since nothing below a row that was never added is ever walked. An entry on
   * `override` or `overrideExact` is still included, as a leaf: its own subtree is a menu of its own
   * (edited separately through the normal override/manual-items path), so the walk does not recurse
   * into it.
   *
   * @param rootFolderPath Encoded ltree path of the folder whose contents this builds a menu from —
   *                        empty at the site root, exactly what `tree.browse()` calls `encodedPath`.
   * @param depth How many folder levels below `rootFolderPath` this call already is. Callers always
   *              start at 0; recursion stops past the same `MAX_DEPTH` `tree.ts` enforces elsewhere.
   */
  private async generateFromTree(
    siteId: string,
    rootFolderPath: string,
    locale: string,
    depth = 0
  ): Promise<NavigationItem[]> {
    if (depth > MAX_DEPTH) {
      return []
    }

    const descendant = alias(treeTable, 'navGenDescendantTree')
    const descendantPage = alias(pagesTable, 'navGenDescendantPage')
    // -> Text rather than an ltree operator, so the child path can be built from a bound prefix and the
    //    row's own name -- the same trick `tree.browse()`'s `holdsVisiblePages` uses
    const childPathPrefix = rootFolderPath ? `${rootFolderPath}.` : ''

    const holdsVisiblePages = exists(
      WIKI.db
        .select({ one: sql`1` })
        .from(descendant)
        .innerJoin(descendantPage, eq(descendantPage.id, descendant.id))
        .where(
          and(
            eq(descendant.siteId, treeTable.siteId),
            eq(descendant.locale, treeTable.locale),
            eq(descendant.type, 'page'),
            sql`${descendant.folderPath} <@ (${childPathPrefix}::text || ${treeTable.fileName})::ltree`,
            ...pageIsVisible(descendantPage, true)
          )
        )
    )

    const rows = await WIKI.db
      .select({
        id: treeTable.id,
        type: treeTable.type,
        fileName: treeTable.fileName,
        title: treeTable.title,
        icon: pagesTable.icon,
        navigationMode: treeTable.navigationMode,
        holdsVisiblePages: sql<boolean>`${holdsVisiblePages}`.mapWith(Boolean)
      })
      .from(treeTable)
      .leftJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.folderPath, rootFolderPath),
          ne(treeTable.type, 'asset'),
          or(
            eq(treeTable.type, 'folder'),
            and(eq(treeTable.type, 'page'), ...pageIsVisible(pagesTable, true))
          )
        )
      )

    const parentPath = decodeTreePath(rootFolderPath) ?? ''

    const candidates = rows
      // -> An empty folder is a dead end -- same as `browse()` drops it
      .filter((row) => row.type !== 'folder' || row.holdsVisiblePages)
      // -> Dropped outright, and -- for the recursive `hide` -- everything below it along with it,
      //    since nothing below a row that was never added is ever walked
      .filter((row) => !(['hide', 'hideExact'] as NavigationMode[]).includes(row.navigationMode))
      .sort((a, b) =>
        compareFoldersFirst(
          { isFolder: a.type === 'folder', title: a.title },
          { isFolder: b.type === 'folder', title: b.title }
        )
      )

    return Promise.all(
      candidates.map(async (row): Promise<NavigationItem> => {
        // -> Only a folder has descendants to walk; a page is always a leaf here regardless of its own
        //    mode, since `override`/`overrideExact` only matters where there is a subtree to stop at
        const isBoundary =
          row.type === 'folder' &&
          (['override', 'overrideExact'] as NavigationMode[]).includes(row.navigationMode)
        const childFolderPath = rootFolderPath ? `${rootFolderPath}.${row.fileName}` : row.fileName
        const children =
          row.type === 'folder' && !isBoundary
            ? await this.generateFromTree(siteId, childFolderPath, locale, depth + 1)
            : []

        return {
          id: row.id,
          type: 'link',
          label: row.title,
          ...(row.icon && { icon: row.icon }),
          // -> Matches how `NavItemEditor.vue`'s manual page-picker builds a link target, so a
          //    generated item and a hand-picked one render identically on the frontend
          ...(row.type === 'page' && {
            target: `/${locale}/${parentPath ? `${parentPath}/${row.fileName}` : row.fileName}`
          }),
          ...(children.length > 0 && { children })
        }
      })
    )
  }

  /**
   * Write a menu's items directly, addressed by the id of the row that already holds it.
   *
   * No page or mode resolution, unlike `updateNavigation` — the caller already knows which row it
   * means, because it read the id off the thing it is editing: the site-wide default (its own id is
   * the site id, see `ensureSiteNav`) or an override's `navigationId` from `listOverrides`. That is
   * what the admin-launched menu editor (Task 433) saves against, as opposed to the page-context
   * editor, which still goes through `updateNavigation` so that saving from an inheriting page can
   * repoint at the ancestor it inherits from.
   *
   * @param navId The row to write to — the site id, or a tree entry id belonging to this site
   */
  async setNavItems(siteId: string, navId: string, items: NavigationItem[]): Promise<void> {
    if (navId === siteId) {
      // -> Falls back to the site menu, and a site created before that row existed does not have one yet
      await this.ensureSiteNav(siteId)
    } else {
      // -> Refuse a navId that names neither the site nor one of its own tree entries, rather than
      //    silently creating a floating navigation row nothing else ever reaches
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
   * site-wide menu when nothing above it does either.
   *
   * @param siteId Site the entry belongs to, since paths are only unique within one
   * @param folderPath Encoded ltree path of the folder holding the entry, empty at the site root
   */
  private async ancestorNavId(siteId: string, folderPath: string): Promise<string | null> {
    if (!folderPath) {
      return siteId
    }
    const result = await WIKI.db.execute(sql`
      SELECT "navigationId"
      FROM tree
      WHERE "siteId" = ${siteId}
        AND ("folderPath" || "fileName") @> ${folderPath}::ltree
        AND "navigationMode" IN ('override', 'hide')
      ORDER BY nlevel("folderPath" || "fileName") DESC
      LIMIT 1
    `)
    const rows = (result.rows ?? result) as any[]
    return rows.length > 0 ? (rows[0].navigationId ?? null) : siteId
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
    return this.ancestorNavId(siteId, entry.folderPath ?? '')
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

    // -> Whatever this change resolves to, `inherit` ultimately falls back to the site menu, and a
    //    site created before that row existed does not have one yet
    await this.ensureSiteNav(siteId)

    const folderPath = entry.folderPath ?? ''
    // -> The home page at the root edits the site-wide menu rather than one of its own, which is what
    //    makes it the menu every other page inherits
    const isSiteRoot = folderPath === '' && entry.fileName === 'home'
    const ownNavId = isSiteRoot ? siteId : entry.id
    const fullPath = folderPath ? `${folderPath}.${entry.fileName}` : entry.fileName

    const ancestorId = await this.ancestorNavId(siteId, folderPath)

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
