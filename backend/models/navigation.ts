import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import {
  navigation as navigationTable,
  pages as pagesTable,
  tree as treeTable
} from '../db/schema.ts'
import { CustomError, decodeTreePath } from '../helpers/common.ts'
import { localizedPagePath } from '../helpers/localeRouting.ts'
import { isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import {
  MAX_DEPTH,
  compareFoldersFirst,
  holdsVisiblePagesUnder,
  pageIsVisible,
  splitPath
} from './tree.ts'
import type { TreeItemType } from './tree.ts'
import type { AccessActor } from './groups.ts'

/**
 * Who a menu rewrite is attributed to in the content lifecycle log. Optional rather than required,
 * deliberately: an unswept caller is then a line reading `user=system` rather than a compile error.
 * `authorId` is the actor's own id, never an e-mail address.
 */
export interface NavigationWriteActor {
  authorId?: string | null
}

function actorFields(authorId?: string | null): { user: string } {
  return { user: authorId || 'system' }
}

export const NAVIGATION_MODES = [
  'inherit',
  'override',
  'overrideExact',
  'hide',
  'hideExact'
] as const
export type NavigationMode = (typeof NAVIGATION_MODES)[number]

/**
 * Where a navigation row's items come from: hand-authored (`static`), a tree walk (`auto`), or the
 * two merged (`mixed`). Resolved by `getNav`.
 */
export const NAVIGATION_SOURCE_MODES = ['static', 'auto', 'mixed'] as const
export type NavigationSourceMode = (typeof NAVIGATION_SOURCE_MODES)[number]

export const NAV_COPY_MODES = ['replace', 'append'] as const
export type NavCopyMode = (typeof NAV_COPY_MODES)[number]

export interface NavigationItem {
  id: string
  type: 'link' | 'header' | 'separator'
  label?: string
  icon?: string
  target?: string
  /**
   * `generated` items only, never stored: the raw tree path, no locale prefix (e.g. `docs/setup`).
   * Distinct from `target`, which is locale-prefixed and only ever set on a page row.
   */
  path?: string
  /**
   * `generated` items only: the tree-row id of the folder CONTAINING this item — `null` at locale
   * root. Folder creation addresses its parent by id while page creation addresses its target by
   * `path` above, so both are surfaced rather than a third addressing scheme.
   */
  folderId?: string | null
  /**
   * `generated` items only, never stored: true for a folder even with no generated `children` — a
   * boundary folder and a genuinely empty one both carry none, but are still folders, not pages.
   */
  isFolder?: boolean
  openInNewWindow?: boolean
  expandByDefault?: boolean
  visibilityGroups?: string[]
  children?: NavigationItem[]
  /**
   * `mixed` menus only: where a stored item sits relative to the generated items it is merged with.
   * Meaningless on a `static` or `auto` menu, and on a nested (`children`) item, since placement is
   * only ever decided at the top level.
   */
  pinned?: 'before' | 'after'
  /**
   * Set by `getNav`, never stored: this item (or nested child) came from `generateFromTree` rather
   * than the row's own `items`. Absent on a `static` menu, and on a `mixed` menu's stored items.
   */
  generated?: boolean
}

export interface UpdateNavigationResult {
  navigationMode: NavigationMode
  navigationId: string | null
  /**
   * The resolved row's own source mode, echoed back only when `updateNavigation` was called with a
   * `menuMode` -- absent, rather than stale, when the call left `navigation.mode` untouched.
   */
  mode?: NavigationSourceMode
}

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

function isVisibleTo(item: NavigationItem, userGroups: string[]): boolean {
  const groups = item.visibilityGroups ?? []
  return groups.length < 1 || groups.some((g) => userGroups.includes(g))
}

/**
 * Whether this actor could actually add a page under a folder path -- what decides whether an
 * otherwise-empty folder is a genuine dead end for them or a container they could populate right
 * now. A folder carries no tags/classification of its own, the same treatment
 * `helpers/pageAccess.ts#mayOnFolder` gives it.
 */
function actorMayPopulate(
  actor: AccessActor,
  siteId: string,
  locale: string,
  path: string
): boolean {
  const candidate = { path, siteId, locale, classification: null }
  return (
    CARDINAL.models.groups.checkAccess(actor, 'write:pages', candidate) ||
    CARDINAL.models.groups.checkAccess(actor, 'manage:pages', candidate)
  )
}

/**
 * One cache entry per menu per locale per `accessKey`, scoped to the site so `invalidateCache` can
 * drop a whole site's worth without touching another site's warm entries.
 */
function navCacheKey(siteId: string, navId: string, locale: string, accessKey: string): string {
  return `nav:${siteId}:${navId}:${locale}:${accessKey}`
}

/**
 * The generated tree bakes each page's link target into the cached items, so a change to
 * forcePrefix, aliases or the primary locale must miss the cache. Nothing else invalidates on a
 * site locale-config edit.
 */
function localeRoutingKey(siteId: string): string {
  const locales = CARDINAL.sites[siteId]?.config?.locales
  return JSON.stringify([
    locales?.primary ?? null,
    (locales?.active?.length ?? 0) > 1,
    locales?.forcePrefix ?? false,
    locales?.aliases ?? null
  ])
}

/**
 * A stable string capturing exactly the parts of an `AccessActor` that a `read:pages` `checkAccess`
 * can vary its answer on. Two actors hashing to the same key are interchangeable for every decision
 * `generateFromTree` makes, so caching its walk under this key can never hand one actor a tree that
 * was really filtered for a different one.
 *
 * `null` (an `unfiltered` read) gets its own fixed key: that walk skips the `read:pages` check
 * entirely, and every real key carries a `groupIds:`/`admin:` prefix this one cannot collide with.
 */
function actorAccessKey(actor: AccessActor | null): string {
  if (!actor) {
    return 'unfiltered'
  }
  // -> `checkAccess` short-circuits on `manage:system`, so nothing else about such an actor can
  //    change the answer.
  if (actor.permissions.includes('manage:system')) {
    return 'admin'
  }
  const groups = [...actor.groupIds].sort().join(',')
  const scope = actor.scope ? [...actor.scope].sort().join(',') : ''
  const classifications = actor.allowedClassifications
    ? [...actor.allowedClassifications].sort().join(',')
    : ''
  const sitePin = actor.siteId ?? ''
  return `groupIds:${groups}|scope:${scope}|class:${classifications}|site:${sitePin}`
}

/**
 * What lets an `auto`/`mixed` editor tell a tree-walk item apart from a hand-authored one in the
 * single combined list `getNav` returns -- without it, editing a `mixed` menu and saving back
 * everything on screen would freeze a snapshot of the generated items into the stored `items`
 * column.
 */
function markGenerated(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    generated: true,
    ...(item.children?.length && { children: markGenerated(item.children) })
  }))
}

/**
 * Deep-clone a menu's items for `copyNav` with a fresh id on every item: the sortable list frontend
 * keys its drag-and-drop state on `id`, so source and target must not share one. `visibilityGroups`
 * is left as-is — groups are instance-wide, so the reference stays correct on the target — and
 * `target` is copied unrewritten, since repointing it at the right page in the destination
 * locale/site is a known best-effort limitation.
 */
function cloneItemsWithFreshIds(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    id: crypto.randomUUID(),
    children: item.children?.length ? cloneItemsWithFreshIds(item.children) : item.children
  }))
}

/**
 * Protocols a navigation item's `target` may use beyond a same-origin rooted path: `mailto:`/`tel:`
 * are legitimate menu destinations with no script-execution risk.
 */
const NAV_TARGET_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'] as const

/**
 * Whether one item's own `target` is safe to store; its `children` are the caller's to recurse into
 * separately. An empty/absent target is fine — a `header`/`separator` item, or a `link` nobody has
 * pointed anywhere yet.
 *
 * Exported, like `assertValidNavItems`/`sanitizeNavItemTargets` below, so the validation can be
 * exercised as a pure unit test rather than only through a DB-backed round trip.
 */
export function isValidNavItemTarget(target: string | undefined): boolean {
  if (target === undefined || target === '') {
    return true
  }
  return isFollowableRedirectTarget(target, { allowedProtocols: NAV_TARGET_PROTOCOLS })
}

/**
 * Refuse a menu whose items — at any depth — carry a `target` that is not `isValidNavItemTarget`: a
 * `site:navigation` holder is a delegated, non-administrator permission, and could otherwise store
 * `javascript:...` as an item's target, which runs for any reader who clicks the sidebar entry it
 * renders as. Called from every write path, so a poisoned source menu cannot be reintroduced onto a
 * clean target through a copy either.
 */
export function assertValidNavItems(items: NavigationItem[]): void {
  for (const item of items) {
    if (!isValidNavItemTarget(item.target)) {
      throw new CustomError(
        'navigationInvalidTarget',
        `Navigation item "${item.id}" has an invalid target. Only a path on this wiki, or a complete http(s)/mailto/tel address, is allowed.`
      )
    }
    if (item.children?.length) {
      assertValidNavItems(item.children)
    }
  }
}

/**
 * Blank any `target` that fails `isValidNavItemTarget`, leaving the rest of the item intact. Used
 * by `copyNav` rather than `assertValidNavItems`'s hard refusal: the source menu may predate this
 * validation existing at all, and dropping just the poisoned target lets the copy still succeed
 * instead of failing the whole operation over data this route did not itself accept.
 */
export function sanitizeNavItemTargets(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    target: isValidNavItemTarget(item.target) ? item.target : '',
    ...(item.children?.length ? { children: sanitizeNavItemTargets(item.children) } : {})
  }))
}

/**
 * A navigation menu is a row of `items` keyed by its own id: a tree entry that overrides the menu
 * below it, addressed by that entry's own id, or — for the site-wide menu every page falls back to —
 * a row identified not by id (a random uuid, meaningless on its own) but by the `(siteId, locale)`
 * pair it belongs to, since a site with more than one active locale needs one such menu per locale.
 * The home page of a given locale edits that locale's site menu rather than one of its own.
 *
 * Which menu a page gets is decided when the mode is saved rather than when the page is rendered:
 * every tree entry carries the resolved `navigationId`, so drawing a sidebar is one lookup.
 */
class Navigation {
  /**
   * Every `getGeneratedTree` cache key issued for a site, so `invalidateCache` can drop them all
   * without asking `CARDINAL.cache` to enumerate its own keys -- the shared `LRUCache` holds other
   * models' entries too, and the test-only stub has no `keys()` at all. Per-instance, same as the
   * cache itself: nothing here needs to survive a restart or be visible to another instance.
   */
  private cacheKeysBySite = new Map<string, Set<string>>()

  /**
   * The resolved items of one menu — hand-authored, tree-generated, or both, depending on the row's
   * `mode`.
   *
   * `unfiltered` never suppresses generation, so a full read of an `auto`/`mixed` menu is the
   * generated preview an editor needs, not just whatever happens to be stored. It skips both
   * filtering passes — visibility groups, and the per-candidate `read:pages` check threaded into
   * `generateFromTree` — since the preview an authorized editor asked for shows the whole structure
   * being edited, regardless of the caller's OWN page-level access. That preview is NOT safe to
   * read back verbatim and re-save through `setNavItems`: saving it as-is freezes a snapshot of the
   * generated items into the stored `items` column, so an editor has to keep the two apart itself.
   *
   * @param siteId Scopes the read the same way `setNavItems`/`copyNav`'s writes do — a row from
   *               another site answers as not-found rather than being handed back.
   * @param id Menu id — a tree entry id, or a site-wide menu's own row id (see `ensureSiteNav`)
   * @param actor Required, not optional: a generated entry comes straight off the tree and must be
   *              checked against `read:pages` the same way `tree.browse()` would, or an anonymous
   *              visitor on an `auto`/`mixed` menu sees the title, path and icon of every
   *              published, browsable page in the tree — including ones a path, tag or
   *              classification DENY keeps them out of. An anonymous request is the guests actor,
   *              never an absence of one.
   */
  async getNav(
    siteId: string,
    id: string,
    {
      actor,
      userGroups = [],
      unfiltered = false
    }: { actor: AccessActor; userGroups?: string[]; unfiltered?: boolean }
  ): Promise<NavigationItem[]> {
    const rows = await CARDINAL.db
      .select({
        items: navigationTable.items,
        mode: navigationTable.mode,
        siteId: navigationTable.siteId,
        locale: navigationTable.locale
      })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, id), eq(navigationTable.siteId, siteId)))
      .limit(1)

    const row = rows[0]
    const items = (row?.items ?? []) as NavigationItem[]

    let combined: NavigationItem[]
    if (!row || row.mode === 'static') {
      combined = items
    } else {
      const { rootFolderPath, rootFolderId, locale } = await this.resolveGeneratorRoot(
        row.siteId,
        id,
        row.locale
      )
      const generated = markGenerated(
        await this.getGeneratedTree(
          row.siteId,
          id,
          rootFolderPath,
          rootFolderId,
          locale,
          unfiltered ? null : actor
        )
      )
      if (row.mode === 'auto') {
        combined = generated
      } else {
        /*
          A single combined list rather than 2.5.x's two-view toggle, with placement decided per
          stored item via `pinned` rather than one fixed prepend-or-append rule -- an author can pin
          a "Home" link before the generated section and leave everything else to fall in after it.
        */
        const before = items.filter((item) => item.pinned === 'before')
        const after = items.filter((item) => item.pinned !== 'before')
        combined = [...before, ...generated, ...after]
      }
    }

    if (unfiltered) {
      return combined
    }
    return combined
      .filter((item) => isVisibleTo(item, userGroups))
      .map((item) =>
        item.children?.length
          ? { ...item, children: item.children.filter((c) => isVisibleTo(c, userGroups)) }
          : item
      )
  }

  /**
   * A menu row's own source mode, with no item resolution -- what a mode selector asks before it
   * has anything to PUT. Falls back to `static` for an id with no row AT ALL, deliberately
   * independent of the schema's own column default: every real navId reaching this method was
   * created up front via `ensureSiteNav`/`ancestorNavId`, which DO pick up that default.
   *
   * @param siteId Required, scoping the lookup the same way every neighbouring method here does --
   *               without it, a `site:navigation` delegate on one site could learn the source mode
   *               of an arbitrary navigation row on ANOTHER site, since the route authorizes
   *               against the site in the URL while this read would not.
   */
  async getMode(siteId: string, id: string): Promise<NavigationSourceMode> {
    const rows = await CARDINAL.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, id), eq(navigationTable.siteId, siteId)))
      .limit(1)
    return rows[0]?.mode ?? 'static'
  }

  /**
   * The generator's own root -- a decoded path and the tree id of the folder living there -- for a
   * menu id, independent of `getNav`'s item resolution and its actor-scoped filtering.
   *
   * What the nav sidebar's root-level "create here" action needs to target the right place: for an
   * `auto`/`mixed` menu belonging to a page/folder-level override, the generator's root is that
   * override's OWN section root, not the locale root, so a hardcoded empty path / `parentId: null`
   * (right only for a site-wide menu) creates in the wrong place. `rootId` is `null` at the
   * site/locale root, where there is no folder entry to name.
   *
   * Meaningless for a `static` menu but resolves anyway rather than refusing -- the caller only
   * renders for an `auto`/`mixed` menu and simply has no use for these values otherwise.
   */
  async getNavRoot(
    siteId: string,
    id: string
  ): Promise<{ rootPath: string; rootId: string | null }> {
    const rows = await CARDINAL.db
      .select({ locale: navigationTable.locale })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, id), eq(navigationTable.siteId, siteId)))
      .limit(1)
    try {
      const { rootFolderPath, rootFolderId } = await this.resolveGeneratorRoot(
        siteId,
        id,
        rows[0]?.locale ?? null
      )
      return { rootPath: decodeTreePath(rootFolderPath) ?? '', rootId: rootFolderId }
    } catch (err: any) {
      // -> A menu id naming neither a stored row nor a real tree entry answers an empty item list
      //    in `getNav` too, so mirror that rather than rejecting the same `Promise.all` the API
      //    route runs this alongside. Narrowed to `getEntry()`'s own failure, not every error -- a
      //    genuine DB fault still surfaces.
      if (err?.name === 'navInvalidPage') {
        return { rootPath: '', rootId: null }
      }
      throw err
    }
  }

  /**
   * The scope a `getNav` generation call walks from. A row carrying its own `locale` is a site-wide
   * default and maps to the site root (empty `folderPath`) in that locale; a row with no `locale`
   * belongs to a tree entry instead, and maps to THAT ENTRY'S OWN `folderPath` -- its parent
   * folder, not a path built from its own name. A menu therefore always generates the section it
   * sits alongside, its siblings, not its own subtree, which is also why an override on a leaf page
   * resolves to a sensible (non-empty) root.
   *
   * `rootFolderId` is the tree id of the folder living at `rootFolderPath`, `null` at the site root
   * where there is no folder entry to resolve -- what a TOP-LEVEL generated item's own `folderId`
   * should be (see `generateFromTree`'s `parentFolderId`).
   */
  private async resolveGeneratorRoot(
    siteId: string,
    id: string,
    rowLocale: string | null
  ): Promise<{ rootFolderPath: string; rootFolderId: string | null; locale: string }> {
    if (rowLocale !== null) {
      return { rootFolderPath: '', rootFolderId: null, locale: rowLocale }
    }
    const entry = await this.getEntry(siteId, id)
    const rootFolderPath = entry.folderPath ?? ''
    const rootFolderId = await this.folderIdForPath(siteId, entry.locale, rootFolderPath)
    return { rootFolderPath, rootFolderId, locale: entry.locale }
  }

  private async folderIdForPath(
    siteId: string,
    locale: string,
    encodedFolderPath: string
  ): Promise<string | null> {
    if (!encodedFolderPath) {
      return null
    }
    const { folderPath, fileName } = splitPath(encodedFolderPath)
    const rows = await CARDINAL.db
      .select({ id: treeTable.id })
      .from(treeTable)
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.type, 'folder'),
          eq(treeTable.folderPath, folderPath),
          eq(treeTable.fileName, fileName)
        )
      )
      .limit(1)
    return rows[0]?.id ?? null
  }

  /**
   * The menu one locale of the site as a whole uses, which is what every page in that locale inherits
   * by default. Returns its row id — never the site id, and not stable to guess at, since it is a
   * plain `defaultRandom()` uuid — so a caller always gets this from here rather than assuming it.
   *
   * Created empty on demand, since an absent menu is an empty one rather than an error, and
   * idempotent: identified by `(siteId, locale)`, not by id, so calling it again for the same site
   * and locale returns the same row instead of creating a second one. Deliberately leaves `mode`
   * unset -- the schema default is what every row created here should get.
   */
  async ensureSiteNav(siteId: string, locale: string): Promise<string> {
    const inserted = await CARDINAL.db
      .insert(navigationTable)
      .values({ siteId, locale, items: [] })
      .onConflictDoNothing({ target: [navigationTable.siteId, navigationTable.locale] })
      .returning({ id: navigationTable.id })
    if (inserted[0]) {
      return inserted[0].id
    }
    const existing = await CARDINAL.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(and(eq(navigationTable.siteId, siteId), eq(navigationTable.locale, locale)))
      .limit(1)
    return existing[0]!.id
  }

  /**
   * Every site-wide default menu's own row id, one per active locale — what a "copy from" picker
   * lists so an admin can pick a source without knowing a raw navigation uuid up front.
   *
   * Deliberately just the site-wide default, not every override: `listOverrides` already covers
   * per-page/per-folder menus, and copying one of those across sites isn't a use case this covers.
   * A site with no active locales configured resolves to an empty list rather than an error.
   */
  async siteRoots(siteId: string): Promise<{ locale: string; navigationId: string }[]> {
    const activeLocales: string[] = CARDINAL.sites[siteId]?.config?.locales?.active ?? []
    return Promise.all(
      activeLocales.map(async (locale) => ({
        locale,
        navigationId: await this.ensureSiteNav(siteId, locale)
      }))
    )
  }

  /**
   * Drop the menus belonging to tree entries that no longer exist: a menu is keyed by the id of the
   * entry that owns it, so deleting a page or a folder would otherwise leave its menu behind with
   * nothing able to reach it. A site-wide menu is identified by `(siteId, locale)` rather than by
   * belonging to a tree entry, so it is not at risk here.
   *
   * @param siteId Scopes the generated-tree cache eviction only; the delete itself trusts the
   *               caller-supplied ids.
   */
  async deleteNavForEntries(siteId: string, ids: string[]): Promise<void> {
    if (ids.length < 1) {
      return
    }
    await CARDINAL.db.delete(navigationTable).where(inArray(navigationTable.id, ids))
    this.invalidateCache(siteId)
  }

  /**
   * A flat scan against `tree`, not a walk of the hierarchy: `navigationMode` and `folderPath` are
   * both indexed, and `ancestorNavId`'s ltree-ancestry logic answers a different question anyway —
   * the single nearest override above one entry, not every entry that overrides.
   *
   * @param locale Every locale when omitted.
   */
  async listOverrides(
    siteId: string,
    { locale }: { locale?: string } = {}
  ): Promise<NavigationOverride[]> {
    const conditions = [eq(treeTable.siteId, siteId), ne(treeTable.navigationMode, 'inherit')]
    if (locale) {
      conditions.push(eq(treeTable.locale, locale))
    }

    const rows = await CARDINAL.db
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
   * `generateFromTree`'s result, cached -- the expensive part of resolving an `auto`/`mixed` menu
   * (one query per folder level, each carrying a correlated `EXISTS`).
   *
   * Only the generated portion is cached, and only BEFORE `getNav`'s `userGroups` visibility pass:
   * caching `combined` or anything after that filter would leak a `visibilityGroups`-restricted
   * stored item between viewers. The per-candidate `read:pages` filter genuinely varies by actor,
   * so the key folds in `actorAccessKey(actor)` rather than being actor-blind -- actors that key
   * the same share one warm entry, and one that keys differently can only ever get its own.
   */
  private async getGeneratedTree(
    siteId: string,
    navId: string,
    rootFolderPath: string,
    rootFolderId: string | null,
    locale: string,
    actor: AccessActor | null
  ): Promise<NavigationItem[]> {
    const key = `${navCacheKey(siteId, navId, locale, actorAccessKey(actor))}:${localeRoutingKey(siteId)}`
    if (CARDINAL.cache.has(key)) {
      return CARDINAL.cache.get(key) as NavigationItem[]
    }
    const generated = await this.generateFromTree(
      siteId,
      rootFolderPath,
      locale,
      actor,
      0,
      rootFolderId
    )
    CARDINAL.cache.set(key, generated)
    let keys = this.cacheKeysBySite.get(siteId)
    if (!keys) {
      keys = new Set()
      this.cacheKeysBySite.set(siteId, keys)
    }
    keys.add(key)
    return generated
  }

  /**
   * Drops every cached generated-tree entry for a site, not just one `navId`: a folder or page
   * anywhere in the tree feeds every ancestor menu whose root sits above it, since each level's
   * `holdsVisiblePages` `EXISTS` is sensitive to what changed below it. Precision traded for
   * correctness rather than computing exactly which `navId`s a given write touched.
   *
   * Public because the cache it guards is also fed from write paths in `models/tree.ts` and
   * `models/pages.ts`, the same cross-model shape `models/glossary.ts#invalidateCache` establishes.
   */
  invalidateCache(siteId: string): void {
    const keys = this.cacheKeysBySite.get(siteId)
    if (!keys) {
      return
    }
    for (const key of keys) {
      CARDINAL.cache.delete(key)
    }
    this.cacheKeysBySite.delete(siteId)
  }

  /**
   * Build a menu by walking the tree instead of reading a hand-authored `items` row — the `auto`
   * and `mixed` source modes. Queries `tree`/`pages` under `rootFolderPath` the same way
   * `tree.browse()` lists a folder, and orders candidates by the same folders-then-title
   * comparator; `asset` entries are never considered.
   *
   * Sub-boundary rule: an entry on `override`/`overrideExact` is included, but as a leaf — its own
   * subtree is a menu of its own, edited separately — so the walk does not recurse into it. A
   * denied or hidden row is dropped outright rather than merely hidden from its own subtree, so a
   * DENY over a branch hides the branch without ever querying below it.
   *
   * @param rootFolderPath Encoded ltree path of the folder whose contents this builds a menu from —
   *                        empty at the site root, exactly what `tree.browse()` calls `encodedPath`.
   * @param actor Who is asking, or `null` to skip the `read:pages` check entirely (an `unfiltered`
   *              read).
   * @param parentFolderId The tree id every item THIS call returns stamps onto its own `folderId` --
   *                        the folder `rootFolderPath` itself names, `null` only at the true site
   *                        root; every recursive call below passes its own `row.id` on.
   */
  private async generateFromTree(
    siteId: string,
    rootFolderPath: string,
    locale: string,
    actor: AccessActor | null,
    depth = 0,
    parentFolderId: string | null = null
  ): Promise<NavigationItem[]> {
    if (depth > MAX_DEPTH) {
      return []
    }

    // -> The same subquery `tree.browse()` runs; the alias suffix only keeps the two from colliding
    //    if a future statement ever carries both.
    const holdsVisiblePages = holdsVisiblePagesUnder(rootFolderPath, true, 'NavGen')

    const rows = await CARDINAL.db
      .select({
        id: treeTable.id,
        type: treeTable.type,
        fileName: treeTable.fileName,
        title: treeTable.title,
        sortOrder: treeTable.sortOrder,
        icon: pagesTable.icon,
        navigationMode: treeTable.navigationMode,
        holdsVisiblePages: sql<boolean>`${holdsVisiblePages}`.mapWith(Boolean),
        // -> Null for a folder row (the left join): a folder carries no tags/classification of its
        //    own, the same treatment `helpers/pageAccess.ts#mayOnFolder` gives it.
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(treeTable)
      .leftJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.folderPath, rootFolderPath),
          or(
            eq(treeTable.type, 'folder'),
            and(eq(treeTable.type, 'page'), ...pageIsVisible(pagesTable, true))
          )
        )
      )

    const parentPath = decodeTreePath(rootFolderPath) ?? ''
    const locales = CARDINAL.sites[siteId]?.config?.locales

    const candidates = rows
      // -> An empty folder is a dead end for a reader who could never add anything there -- but not
      //    for an actor who could populate it right now, nor for an unfiltered read (the nav
      //    editor's full-structure preview, which by the same reasoning skips the filter below).
      .filter(
        (row) =>
          row.type !== 'folder' ||
          row.holdsVisiblePages ||
          !actor ||
          actorMayPopulate(
            actor,
            siteId,
            locale,
            parentPath ? `${parentPath}/${row.fileName}` : row.fileName
          )
      )
      // -> For the recursive `hide`, everything below goes too: nothing below a row that was never
      //    added is ever walked
      .filter((row) => !(['hide', 'hideExact'] as NavigationMode[]).includes(row.navigationMode))
      // -> `null` (an `unfiltered` read) skips the `read:pages` gate entirely, same as the
      //    `visibilityGroups` pass in `getNav` does for that read.
      .filter((row) => {
        if (!actor) {
          return true
        }
        const path = parentPath ? `${parentPath}/${row.fileName}` : row.fileName
        return CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path,
          siteId,
          locale,
          tags: row.tags ?? [],
          classification: row.classification ?? null
        })
      })
      .sort((a, b) =>
        compareFoldersFirst(
          { isFolder: a.type === 'folder', title: a.title, sortOrder: a.sortOrder },
          { isFolder: b.type === 'folder', title: b.title, sortOrder: b.sortOrder }
        )
      )

    const built = await Promise.all(
      candidates.map(async (row): Promise<NavigationItem | null> => {
        const path = parentPath ? `${parentPath}/${row.fileName}` : row.fileName

        // -> A page is always a leaf here whatever its own mode: `override`/`overrideExact` only
        //    matters where there is a subtree to stop at
        const isFolder = row.type === 'folder'
        const isBoundary =
          isFolder &&
          (['override', 'overrideExact'] as NavigationMode[]).includes(row.navigationMode)
        const childFolderPath = rootFolderPath ? `${rootFolderPath}.${row.fileName}` : row.fileName
        const children =
          isFolder && !isBoundary
            ? await this.generateFromTree(siteId, childFolderPath, locale, actor, depth + 1, row.id)
            : []

        // -> A non-boundary folder that recursed to nothing is a dead end: drop it rather than emit
        //    a folder link with nowhere to go. Only reachable once `actor` is filtering descendants
        //    out one by one, since `holdsVisiblePages` already guarantees a browsable page
        //    below -- which is why that guard is here: a genuinely empty folder that survived the
        //    candidate filter via `actorMayPopulate`/an unfiltered read is a container this actor
        //    could add to right now, so it stays as a childless leaf.
        if (isFolder && !isBoundary && children.length === 0 && row.holdsVisiblePages) {
          return null
        }

        return {
          id: row.id,
          type: 'link',
          label: row.title,
          path,
          folderId: parentFolderId,
          ...(isFolder && { isFolder: true }),
          ...(row.icon && { icon: row.icon }),
          // -> Locale-prefixed only when the site's routing rules call for it, matching how the
          //    manual page-picker builds a link target, so a generated item and a hand-picked one
          //    render identically on the frontend
          ...(row.type === 'page' && {
            target: localizedPagePath(path, locale, locales)
          }),
          ...(children.length > 0 && { children })
        }
      })
    )

    return built.filter((item): item is NavigationItem => item !== null)
  }

  /**
   * Write a menu's items directly, addressed by the id of the row that already holds it.
   *
   * No page or mode resolution, unlike `updateNavigation` — the caller already knows which row it
   * means, because it read the id off the thing it is editing. That is what the admin-launched menu
   * editor saves against, as opposed to the page-context editor, which still goes through
   * `updateNavigation` so that saving from an inheriting page can repoint at the ancestor it inherits
   * from.
   *
   * @param authorId For the lifecycle log line alone — see `NavigationWriteActor`.
   */
  async setNavItems(
    siteId: string,
    navId: string,
    items: NavigationItem[],
    { authorId }: NavigationWriteActor = {}
  ): Promise<void> {
    assertValidNavItems(items)
    // -> `locale` is set only on a site-wide default row (null for a tree-entry override), which is
    //    exactly the distinction the log line below wants to draw.
    const existing = await CARDINAL.db
      .select({ id: navigationTable.id, locale: navigationTable.locale })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, navId), eq(navigationTable.siteId, siteId)))
      .limit(1)
    if (existing.length < 1) {
      // -> Refuse a navId that names neither an existing menu row of this site nor one of its own
      //    tree entries, rather than silently creating a floating navigation row nothing can reach
      await this.getEntry(siteId, navId)
    }

    await CARDINAL.db
      .insert(navigationTable)
      .values({ id: navId, siteId, items })
      .onConflictDoUpdate({ target: navigationTable.id, set: { items } })
    this.invalidateCache(siteId)

    // -> A menu is what the whole site navigates by, so a rewrite of one is worth an `info` line
    //    even though it is not a page. Emitted from the model, not the route, so the admin menu
    //    editor and the page-context editor (`updateNavigation` below) read the same in the log.
    CARDINAL.logger.info('nav', 'updated', {
      site: siteId,
      nav: navId,
      ...(existing[0]?.locale ? { locale: existing[0].locale } : {}),
      items: items.length,
      ...actorFields(authorId)
    })
  }

  /**
   * Copy one menu's items onto another, addressed by id exactly like `setNavItems` — a same-site
   * "copy from locale" or a genuinely cross-site copy.
   *
   * Reads the source's raw, unfiltered items: an editor copying a menu needs every item, not just
   * what the requester's own groups can see. An UNSAFE item `target` (`javascript:` and friends) is
   * stripped rather than carried over, so a source menu poisoned before this validation existed, or
   * one written straight to the database, cannot be reintroduced onto a clean target this way.
   *
   * @param mode `append` pushes the clones onto whatever the target already has, matching 2.5.x's
   *             "copy from locale" merge behavior; `replace` overwrites the target's items.
   */
  async copyNav({
    sourceSiteId,
    sourceId,
    targetSiteId,
    targetId,
    mode,
    authorId
  }: {
    sourceSiteId: string
    sourceId: string
    targetSiteId: string
    targetId: string
    mode: NavCopyMode
  } & NavigationWriteActor): Promise<void> {
    const sourceRows = await CARDINAL.db
      .select({ items: navigationTable.items })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, sourceId), eq(navigationTable.siteId, sourceSiteId)))
      .limit(1)
    const sourceRow = sourceRows[0]
    if (!sourceRow) {
      throw new CustomError('navCopySourceNotFound', 'The source menu does not exist.', 404)
    }

    const targetRows = await CARDINAL.db
      .select({ items: navigationTable.items })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, targetId), eq(navigationTable.siteId, targetSiteId)))
      .limit(1)
    const targetRow = targetRows[0]
    if (!targetRow) {
      throw new CustomError('navCopyTargetNotFound', 'The target menu does not exist.', 404)
    }

    const clonedItems = sanitizeNavItemTargets(
      cloneItemsWithFreshIds((sourceRow.items ?? []) as NavigationItem[])
    )
    const items =
      mode === 'append'
        ? [...((targetRow.items ?? []) as NavigationItem[]), ...clonedItems]
        : clonedItems

    await CARDINAL.db.update(navigationTable).set({ items }).where(eq(navigationTable.id, targetId))

    // -> The same line the other two write paths emit -- the target really does navigate
    //    differently afterwards, so a copy must not be the one rewrite invisible in the log. `from`
    //    is the whole of what distinguishes it from an ordinary save.
    CARDINAL.logger.info('nav', 'updated', {
      site: targetSiteId,
      nav: targetId,
      from: sourceId,
      items: items.length,
      copy: mode,
      ...actorFields(authorId)
    })
  }

  private async getEntry(siteId: string, pageId: string) {
    const entries = await CARDINAL.db
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
   * Public so `TreeModel#addEntry` can resolve a new or moved page's `navigationId` from its
   * folder ancestry at insert time, rather than defaulting it to the site-wide menu.
   *
   * @param locale An ancestor override in a different locale that happens to share the same path is
   *               not this entry's ancestor
   * @param folderPath Encoded ltree path of the folder holding the entry, empty at the site root
   */
  async ancestorNavId(siteId: string, locale: string, folderPath: string): Promise<string | null> {
    if (!folderPath) {
      return this.ensureSiteNav(siteId, locale)
    }
    const result = await CARDINAL.db.execute(sql`
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
   * Null when the nearest ancestor hides the sidebar, which leaves nothing to inherit.
   */
  async inheritedNavId(siteId: string, pageId: string): Promise<string | null> {
    const entry = await this.getEntry(siteId, pageId)
    return this.ancestorNavId(siteId, entry.locale, entry.folderPath ?? '')
  }

  /**
   * Set how a page decides its sidebar, and optionally the menu itself. Two things move: the entry
   * records its own mode and the menu it resolves to, and — when the change alters what descendants
   * inherit — every entry below it that is still on `inherit` is repointed, stopping at any that
   * overrides or hides in between.
   *
   * `mode` is the entry's cascade setting (`NavigationMode`, deciding WHICH menu a page's sidebar
   * resolves to). `menuMode` is a different axis entirely: the resolved menu ROW's own `mode`
   * column (`NavigationSourceMode`, deciding whether that menu's items are hand-authored,
   * tree-generated, or both). The two can change independently in the same call, which is why they
   * are separate parameters rather than one being folded into the other.
   *
   * @param items The menu the mode resolves to, replacing whatever was there — this entry's own, or
   *              the one it inherits when the mode is `inherit`
   * @param menuMode Written to the same target row `items` would (`ancestorId` under `inherit`,
   *                 `ownNavId` otherwise), independent of whether `items` is also given.
   * @param authorId For the lifecycle log line alone — see `NavigationWriteActor`.
   */
  async updateNavigation({
    siteId,
    pageId,
    mode,
    items,
    menuMode,
    authorId
  }: {
    siteId: string
    pageId: string
    mode: NavigationMode
    items?: NavigationItem[]
    menuMode?: NavigationSourceMode
  } & NavigationWriteActor): Promise<UpdateNavigationResult> {
    const entry = await this.getEntry(siteId, pageId)

    // -> `inherit` ultimately falls back to this entry's locale's site menu, and a site created
    //    before that row existed — or a locale activated since — does not have one yet
    const siteNavId = await this.ensureSiteNav(siteId, entry.locale)

    const folderPath = entry.folderPath ?? ''
    // -> The home page at the root edits its locale's site-wide menu rather than one of its own, which
    //    is what makes it the menu every other page in that locale inherits
    const isSiteRoot = folderPath === '' && entry.fileName === 'home'
    const ownNavId = isSiteRoot ? siteNavId : entry.id
    const fullPath = folderPath ? `${folderPath}.${entry.fileName}` : entry.fileName

    const ancestorId = await this.ancestorNavId(siteId, entry.locale, folderPath)

    if (items) {
      assertValidNavItems(items)
    }

    if (items || menuMode) {
      /*
        Which menu the items belong to is the mode's answer, not the entry's: a page that inherits
        shows a menu belonging to an ancestor, so editing the sidebar from that page edits THAT menu
        rather than starting one of its own that nothing would point at. For the root home page the
        two are the same id.
      */
      const targetNavId = mode === 'inherit' ? ancestorId : ownNavId
      if (!targetNavId) {
        throw new CustomError(
          'navNoInheritedMenu',
          'This page inherits a hidden sidebar, so there is no menu to save items to.',
          400
        )
      }
      const set: { items?: NavigationItem[]; mode?: NavigationSourceMode } = {}
      if (items) {
        set.items = items
      }
      if (menuMode) {
        set.mode = menuMode
      }
      /*
        Items with no explicit mode are always a hand-authored menu, and the bare schema default
        (`auto`) would otherwise make `getNav()` ignore them entirely in favor of a tree-generated
        menu. INSERT branch only: an existing row's mode is left alone unless `menuMode` is
        explicitly given, and a bare mode switch with neither reaches this block at all, so
        `ensureSiteNav`'s "no items at all defaults to auto" behavior still holds.
      */
      const insertMode = menuMode ?? (items ? 'static' : undefined)
      await CARDINAL.db
        .insert(navigationTable)
        .values({
          id: targetNavId,
          siteId,
          items: items ?? [],
          ...(insertMode && { mode: insertMode })
        })
        .onConflictDoUpdate({ target: navigationTable.id, set })
    }

    /*
      `override`/`overrideExact` always point `tree.navigationId` at `ownNavId` below, and the FK on
      that column means the row has to actually exist first. The block above only creates it when
      `items`/`menuMode` was given; a bare mode switch (an editor toggling a page to `override`
      before ever touching its sidebar) reaches here with neither, so ensure the row on its own.
      `onConflictDoNothing` keeps this a no-op once the row is real, rather than clobbering items.
    */
    if ((mode === 'override' || mode === 'overrideExact') && !(items || menuMode)) {
      await CARDINAL.db
        .insert(navigationTable)
        .values({ id: ownNavId, siteId, items: [] })
        .onConflictDoNothing()
    }

    // -> Only an entry that WAS cascading has descendants to hand back to the ancestor below
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

    await CARDINAL.db
      .update(treeTable)
      .set({ navigationMode: mode, navigationId: navId })
      .where(eq(treeTable.id, entry.id))

    if (cascadeTo !== undefined) {
      // -> Everything below that still inherits, except what sits under a nearer override or hide,
      //    which owns its own subtree. The boundary paths are collected once into a CTE rather than
      //    recomputed by a correlated NOT EXISTS on every candidate row — same boundary set, same
      //    containment predicate, evaluated per boundary instead of per row.
      await CARDINAL.db.execute(sql`
        WITH boundaries AS (
          SELECT (tc."folderPath" || tc."fileName") AS "boundaryPath"
          FROM tree tc
          WHERE tc."siteId" = ${siteId}
            AND tc."locale" = ${entry.locale}
            AND tc.tree IN ('page', 'folder')
            AND tc."folderPath" <@ ${fullPath}::ltree
            AND tc."navigationMode" IN ('override', 'hide')
        )
        UPDATE tree tt
        SET "navigationId" = ${cascadeTo}
        WHERE tt."siteId" = ${siteId}
          AND tt."locale" = ${entry.locale}
          AND tt.tree IN ('page', 'folder')
          AND tt."folderPath" <@ ${fullPath}::ltree
          AND tt."navigationMode" = 'inherit'
          AND NOT EXISTS (
            SELECT 1
            FROM boundaries b
            WHERE b."boundaryPath" @> tt."folderPath"
          )
      `)
    }

    // -> A `navigationMode` flip changes whether `generateFromTree` treats this entry as a
    //    boundary, hidden, or an ordinary walked node, so every cached menu for the site is dropped
    //    rather than trying to name just the affected ones
    this.invalidateCache(siteId)

    // -> Same line `setNavItems` emits, from the other editor. `page` and `mode` are what this path
    //    knows and that one does not: the sidebar was edited from a page, and the page's own
    //    cascade setting may have moved with it. `items` is absent for a bare mode switch.
    CARDINAL.logger.info('nav', 'updated', {
      site: siteId,
      ...(navId ? { nav: navId } : {}),
      locale: entry.locale,
      page: pageId,
      mode,
      ...(items ? { items: items.length } : {}),
      ...actorFields(authorId)
    })

    return { navigationMode: mode, navigationId: navId, ...(menuMode && { mode: menuMode }) }
  }
}

export const navigation = new Navigation()
