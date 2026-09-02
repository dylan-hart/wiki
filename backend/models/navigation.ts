import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import {
  navigation as navigationTable,
  pages as pagesTable,
  tree as treeTable
} from '../db/schema.ts'
import { CustomError, decodeTreePath, localizedPagePath } from '../helpers/common.ts'
import { isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import { MAX_DEPTH, compareFoldersFirst, holdsVisiblePagesUnder, pageIsVisible } from './tree.ts'
import type { TreeItemType } from './tree.ts'
import type { AccessActor } from './groups.ts'

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
 * default, and the only value any row had before this feature) is hand-authored items exactly as
 * `setNavItems` already works; `auto` and `mixed` are resolved by `getNav`, which walks the tree via
 * `generateFromTree` instead of (`auto`) or alongside (`mixed`) the stored `items`.
 */
export const NAVIGATION_SOURCE_MODES = ['static', 'auto', 'mixed'] as const
export type NavigationSourceMode = (typeof NAVIGATION_SOURCE_MODES)[number]

/**
 * How `copyNav` merges cloned items into the target menu.
 *
 * `replace` overwrites the target's `items` outright; `append` pushes the cloned items onto whatever
 * is already there, matching 2.5.x's "copy from locale" merge behavior.
 */
export const NAV_COPY_MODES = ['replace', 'append'] as const
export type NavCopyMode = (typeof NAV_COPY_MODES)[number]

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
  /**
   * `mixed` menus only: where a stored (manually-authored) top-level item sits relative to the
   * generated tree-walk items it is merged with -- see the merge-rule comment on `getNav`. Meaningless
   * on a `static` or `auto` menu, and on a nested (`children`) item, since placement is only ever
   * decided at the top level.
   */
  pinned?: 'before' | 'after'
  /**
   * Set by `getNav` (never stored) on every item -- and nested child -- that came from `generateFromTree`
   * rather than the row's own `items` column, on an `auto` or `mixed` menu. Absent on a `static` menu's
   * items, and on a `mixed` menu's stored items, since neither is ever generated. See `markGenerated`.
   */
  generated?: boolean
}

export interface UpdateNavigationResult {
  navigationMode: NavigationMode
  navigationId: string | null
  /**
   * The resolved navigation row's own `mode` (static/auto/mixed) -- present only when `updateNavigation`
   * was called with a `menuMode`, in which case it echoes back what was just written. Absent (not
   * `undefined`-but-stale) when the call left `navigation.mode` untouched, since a caller that didn't
   * send `menuMode` may not otherwise know the row's current source mode.
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
 * The `WIKI.cache` key `getGeneratedTree` caches `generateFromTree`'s output under (OpenProject
 * #1825) -- one per menu per locale per `accessKey` (see `actorAccessKey` below), scoped to the site
 * so `invalidateCache` can drop a whole site's worth without touching another site's warm entries.
 */
function navCacheKey(siteId: string, navId: string, locale: string, accessKey: string): string {
  return `nav:${siteId}:${navId}:${locale}:${accessKey}`
}

/**
 * A stable string capturing exactly the parts of an `AccessActor` that `checkAccess(actor,
 * 'read:pages', ...)` can vary its answer on -- what `generateFromTree`'s per-candidate `read:pages`
 * filter (OpenProject #2155) actually reads off the actor it is given. Two actors that hash to the
 * same key are guaranteed interchangeable for every `read:pages` decision `generateFromTree` makes,
 * so caching its result under this key (OpenProject #1825) can never hand one actor a tree walk that
 * was really filtered for a different one.
 *
 * `null` (an `unfiltered` read -- see `getNav`'s own `unfiltered` doc) gets its own fixed key: the
 * walk it produces skips the `read:pages` check entirely, which no real actor's key could ever
 * collide with by chance (every real key carries a `groupIds:`/`admin:` prefix this doesn't).
 *
 * In practice this buckets tightly: almost every anonymous visitor is the same guests actor with no
 * scope, no classification allow-set and no site pin, so they all share one cache entry -- the
 * caching win this feature exists for. A signed-in reader with their own groups gets their own
 * entry, correctly, rather than being served (or serving) another actor's filtered view.
 */
function actorAccessKey(actor: AccessActor | null): string {
  if (!actor) {
    return 'unfiltered'
  }
  // -> Mirrors `Groups#checkAccess`'s own short-circuit: an actor holding `manage:system` skips the
  //    rule engine entirely, so nothing else about it can change the answer.
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
 * Marks a `generateFromTree` result (and every nested child of it) as `generated`, recursively.
 *
 * What lets an `auto`/`mixed` editor (Task 464's `NavItemEditor.vue`) tell a tree-walk item apart from
 * a hand-authored one in the single combined list `getNav` returns -- without it, editing a `mixed`
 * menu and saving back everything on screen would freeze a snapshot of the generated items into the
 * stored `items` column, exactly the footgun documented on `getNav` above. Applied only in `getNav`,
 * not on `generateFromTree`'s own result, since "generated" is a property of how `getNav` is presenting
 * an item to a caller, not of the tree walk itself.
 */
function markGenerated(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    generated: true,
    ...(item.children?.length && { children: markGenerated(item.children) })
  }))
}

/**
 * Deep-clone a menu's items for `copyNav`, giving every item — top-level and nested child alike — a
 * fresh id, since the sortable list frontend keys its drag-and-drop state on `id` and the source and
 * target menus must not share one.
 *
 * `visibilityGroups` is left as-is on purpose: groups are instance-wide, so the reference copied over
 * from the source item is still correct on the target, whatever site or locale it belongs to. `target`
 * (the link itself) is copied unrewritten too — pointing it at the right page in the destination
 * locale/site is a known best-effort limitation here, same as 2.5.x's own "copy from locale".
 */
function cloneItemsWithFreshIds(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    id: crypto.randomUUID(),
    children: item.children?.length ? cloneItemsWithFreshIds(item.children) : item.children
  }))
}

/**
 * Protocols a navigation item's `target` may use, beyond a same-origin rooted path: `mailto:`/`tel:`
 * are legitimate menu destinations with no script-execution risk, alongside plain `http:`/`https:`.
 */
const NAV_TARGET_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'] as const

/**
 * Whether one item's own `target` (its `children`, if any, are the caller's to recurse into
 * separately) is safe to store. An empty/absent target is fine — a `header`/`separator` item, or a
 * `link` nobody has pointed anywhere yet.
 *
 * Exported (alongside `assertValidNavItems`/`sanitizeNavItemTargets` below) purely so
 * `navigation.test.ts` can exercise this validation directly as a pure unit test, rather than only
 * indirectly through a DB-backed `setNavItems`/`copyNav` round trip -- see this repo's own testing
 * convention for preferring a pure test over a database one wherever the thing under test does not
 * actually require SQL orchestration to verify.
 */
export function isValidNavItemTarget(target: string | undefined): boolean {
  if (target === undefined || target === '') {
    return true
  }
  return isFollowableRedirectTarget(target, { allowedProtocols: NAV_TARGET_PROTOCOLS })
}

/**
 * Refuse a menu whose items — at any depth — carry a `target` that is not `isValidNavItemTarget`.
 * OpenProject #1360/#2208 §3, 2026-08-24 security audit: a `site:navigation` holder (a delegated,
 * non-administrator permission) can otherwise store `javascript:...` as an item's target, which runs
 * for any reader who clicks the sidebar entry it renders as. Called from every write path —
 * `setNavItems` (the two `PUT` routes) and `copyNav` — so a poisoned source menu cannot be
 * reintroduced onto a clean target through a copy either.
 *
 * @throws {CustomError} 400, naming the offending item, on the first invalid target found
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
 * Recursively blank any `target` that fails `isValidNavItemTarget`, leaving the rest of the item (and
 * its children) intact. Used by `copyNav` rather than `assertValidNavItems`'s hard refusal: the items
 * it clones were written by `cloneItemsWithFreshIds` from whatever the source menu already holds,
 * which may predate this validation existing at all — dropping just the poisoned target lets the copy
 * still succeed instead of failing the whole operation over data this route did not itself accept.
 */
export function sanitizeNavItemTargets(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    target: isValidNavItemTarget(item.target) ? item.target : '',
    ...(item.children?.length ? { children: sanitizeNavItemTargets(item.children) } : {})
  }))
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
   * Every `getGeneratedTree` cache key issued for a site, so `invalidateCache` can drop them all
   * without asking `WIKI.cache` to enumerate its own keys -- the shared `LRUCache` holds entries for
   * other models too, and the test-only stub in `test/mocks.ts` has no `keys()` at all. In-memory and
   * per-instance, same as `WIKI.cache` itself: nothing here needs to survive a restart or be visible
   * to another instance in an HA deployment.
   */
  private cacheKeysBySite = new Map<string, Set<string>>()

  /**
   * The resolved items of one menu — hand-authored, tree-generated, or both, depending on the row's
   * `mode`.
   *
   * `static` returns the stored `items` unchanged, exactly as before this feature. `auto` ignores
   * `items` entirely and returns a fresh `generateFromTree` walk instead. `mixed` computes both and
   * combines them into a single list (see the merge-rule comment below) rather than the two-view
   * `Main Menu`/`Browse` toggle 2.5.x used, which is the source of real user confusion this feature
   * deliberately does not reproduce.
   *
   * `unfiltered` never changes whether generation runs, so a `full=true` read of an `auto`/`mixed`
   * menu is the generated preview an editor needs to show, not just whatever happens to be stored.
   * It DOES control two filtering passes now (OpenProject #2155, previously just the one): the
   * visibility-group pass at the end, and (threaded into `generateFromTree`) the `read:pages` check
   * every generated candidate is run through — both skipped under `unfiltered`, since the "full"
   * preview an authorized editor asked for is meant to show the whole structure being edited,
   * regardless of the caller's OWN page-level access, the same reasoning that already applied to
   * visibility groups. Note for whoever builds `mixed` editing (task 464): that preview is not safe
   * to read back verbatim and re-save through `setNavItems` — it contains generated items alongside
   * the stored ones, and saving it as-is would freeze a snapshot of the generated items into the
   * stored `items` column. The editor needs to keep the two apart itself (e.g. only ever writing
   * back the subset it loaded as stored), not rely on this method to do it.
   *
   * @param siteId The site the menu is expected to belong to. Scopes the read the same way
   *               `setNavItems`/`copyNav`'s writes already do — a row belonging to another site
   *               answers as not-found rather than being handed back (OpenProject #941).
   * @param id Menu id — a tree entry id, or a site-wide menu's own row id (see `ensureSiteNav`)
   * @param actor Who is reading (OpenProject #2155) — required, not optional: a `static` menu's
   *              hand-authored items were never gated by page rules (they carry their own
   *              `visibilityGroups`, checked below via `isVisibleTo`), but a generated (`auto`/
   *              `mixed`) entry comes straight off the tree and has to be checked against
   *              `read:pages` the same way `tree.browse()` would, or an anonymous visitor on a menu
   *              switched to `auto`/`mixed` sees the title, path and icon of every published,
   *              browsable page in the tree — including ones a path, tag or classification DENY
   *              keeps them out of. An anonymous request is the guests actor, never an absence of
   *              one — see CLAUDE.md's Permissions section.
   * @param userGroups Groups the viewer belongs to. Items limited to other groups are dropped, at both
   *                   levels, unless `unfiltered` is set.
   * @param unfiltered Return every item regardless of visibility, which is what editing one needs —
   *                   an editor previewing an `auto`/`mixed` menu needs to see the full generated
   *                   structure to edit it, the same reasoning `visibilityGroups` filtering already
   *                   used here, so this also skips the per-entry `read:pages` check below.
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
    const rows = await WIKI.db
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
      const { rootFolderPath, locale } = await this.resolveGeneratorRoot(row.siteId, id, row.locale)
      const generated = markGenerated(
        await this.getGeneratedTree(
          row.siteId,
          id,
          rootFolderPath,
          locale,
          unfiltered ? null : actor
        )
      )
      if (row.mode === 'auto') {
        combined = generated
      } else {
        /*
          Merge rule for `mixed`, per this feature's brief: a single combined list rather than 2.5.x's
          two-view toggle, with placement decided per stored item via `pinned` rather than a single
          fixed prepend-or-append rule -- a menu author can pin a "Home" link before the generated
          section and leave everything else to fall in after it, in the same list. An item with no
          `pinned` (or any value other than 'before') defaults to 'after', so a `mixed` menu with no
          pinning at all behaves as "generated items, then whatever is stored" -- the least surprising
          default, and the same shape `auto` already has plus manual items tacked on.
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
   * A menu row's own source mode (`static`/`auto`/`mixed`), with no item resolution -- what
   * `NavEditMenu.vue`'s mode selector (Task 464) asks before it has anything to PUT, so it can
   * preselect the option that is actually stored rather than always defaulting to `static`. `static`
   * (the schema default) for a menu with no row yet, same fallback `getNav` uses.
   *
   * @param siteId Required (OpenProject #2127/#2135), scoping the lookup the same way every
   *               neighbouring method here (`getNav()`, `setNavItems()`, `copyNav()`) already does --
   *               without it, a `site:navigation` delegate on one site could learn whether an
   *               arbitrary navigation row on ANOTHER site is `static`/`auto`/`mixed`, since the
   *               route's own authorization is checked against the site in the URL while this read
   *               was not.
   * @param id Menu id -- a tree entry id, or a site id for the site-wide menu
   */
  async getMode(siteId: string, id: string): Promise<NavigationSourceMode> {
    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, id), eq(navigationTable.siteId, siteId)))
      .limit(1)
    return rows[0]?.mode ?? 'static'
  }

  /**
   * The scope a `getNav` generation call walks from, for a given menu row -- resolved the same way
   * `updateNavigation` already resolves `ownNavId`/`ancestorId`: a row carrying its own `locale` (see
   * the schema comment on `navigation.locale`) is a site-wide default, and maps to the site root
   * (empty `folderPath`) in that locale; a row with no `locale` of its own belongs to a tree entry
   * instead, and maps to THAT ENTRY'S OWN `folderPath` (its parent folder, not a path built from its
   * own name) and locale, exactly as stored on it. A menu therefore always generates the section it
   * sits alongside -- its siblings -- not its own subtree, which is also why an override on a leaf
   * page resolves to a sensible (non-empty) root.
   */
  private async resolveGeneratorRoot(
    siteId: string,
    id: string,
    rowLocale: string | null
  ): Promise<{ rootFolderPath: string; locale: string }> {
    if (rowLocale !== null) {
      return { rootFolderPath: '', locale: rowLocale }
    }
    const entry = await this.getEntry(siteId, id)
    return { rootFolderPath: entry.folderPath ?? '', locale: entry.locale }
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
   *
   * Deliberately does not set `mode` -- the schema default (`static`) is what every row created here
   * should get, so a row this creates behaves exactly as it did before `mode` existed.
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
   * Every site-wide default menu's own row id, one per active locale — what a "copy from" picker
   * lists so an admin can pick a source without knowing a raw navigation uuid up front.
   *
   * Deliberately just the site-wide default, not every override: `listOverrides` already covers
   * per-page/per-folder menus, and copying one of those across sites isn't a use case this covers.
   *
   * Reads `siteId`'s active locales from the cached site config rather than taking them as a
   * parameter, same as `defaultLocale` in `helpers/common.ts` reaching into `WIKI.sites` directly —
   * a site with none configured (or one this instance doesn't know about) resolves to an empty list
   * rather than an error, since there is nothing to enumerate.
   */
  async siteRoots(siteId: string): Promise<{ locale: string; navigationId: string }[]> {
    const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? []
    return Promise.all(
      activeLocales.map(async (locale) => ({
        locale,
        navigationId: await this.ensureSiteNav(siteId, locale)
      }))
    )
  }

  /**
   * Drop the menus belonging to tree entries that no longer exist.
   *
   * A menu is keyed by the id of the entry that owns it, so deleting a page or a folder would
   * otherwise leave its menu behind with nothing able to reach it. A site-wide menu is identified by
   * `(siteId, locale)` rather than by belonging to a tree entry, so it is not at risk here.
   *
   * @param siteId Site the removed entries belonged to — scopes the generated-tree cache eviction
   *               (OpenProject #1825) this triggers; not used to filter the delete itself, which
   *               already trusts the caller-supplied ids the same way it did before this parameter
   *               existed.
   * @param ids Tree entry ids being removed
   */
  async deleteNavForEntries(siteId: string, ids: string[]): Promise<void> {
    if (ids.length < 1) {
      return
    }
    await WIKI.db.delete(navigationTable).where(inArray(navigationTable.id, ids))
    this.invalidateCache(siteId)
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
   * `generateFromTree`'s result, cached under `WIKI.cache` (OpenProject #1825) -- the actual expensive
   * part of resolving an `auto`/`mixed` menu (one query per folder level, each carrying a correlated
   * `EXISTS`; F folders means F+1 queries with nothing cached). Cached BEFORE `getNav`'s `userGroups`
   * visibility pass, deliberately: `visibilityGroups` filtering only ever narrows the row's own
   * hand-authored `items`, never the generated portion this caches, so it is safe to apply after a
   * cache hit the same way it always ran after a fresh walk.
   *
   * The `read:pages` filter (OpenProject #2155) `generateFromTree` runs per candidate is a different
   * story -- ITS answer genuinely varies by actor, so the cache key folds in `actorAccessKey(actor)`
   * rather than being actor-blind: two actors that key the same (in practice, almost every anonymous
   * visitor) share one warm entry, and one that keys differently gets, and can only ever get, its own
   * -- never another actor's filtered walk. Caching `combined` (post-merge, for a `mixed` menu) or
   * anything after the `userGroups` filter would still leak a `visibilityGroups`-restricted stored
   * item between viewers regardless of the key, so caching only the generated portion, before that
   * filter runs, stays load-bearing.
   *
   * @param actor Threaded straight through to `generateFromTree` -- `null` for an `unfiltered` read.
   */
  private async getGeneratedTree(
    siteId: string,
    navId: string,
    rootFolderPath: string,
    locale: string,
    actor: AccessActor | null
  ): Promise<NavigationItem[]> {
    const key = navCacheKey(siteId, navId, locale, actorAccessKey(actor))
    if (WIKI.cache.has(key)) {
      return WIKI.cache.get(key) as NavigationItem[]
    }
    const generated = await this.generateFromTree(siteId, rootFolderPath, locale, actor)
    WIKI.cache.set(key, generated)
    let keys = this.cacheKeysBySite.get(siteId)
    if (!keys) {
      keys = new Set()
      this.cacheKeysBySite.set(siteId, keys)
    }
    keys.add(key)
    return generated
  }

  /**
   * Drops every cached generated-tree entry for a site — every `auto`/`mixed` menu's walk, not just
   * one `navId`. A single write can change what more than one menu's walk would return: a folder or
   * page anywhere in the tree feeds every ancestor menu whose root sits above it (each level's
   * `holdsVisiblePages` `EXISTS` is itself sensitive to what changed below it), not only the menu
   * keyed to the entry that changed directly -- so this trades precision for correctness rather than
   * trying to compute exactly which `navId`s a given write touched.
   *
   * Public because the cache this guards is fed from write paths outside this model —
   * `models/tree.ts`'s folder/page create/rename/delete paths and `models/pages.ts`'s
   * publish/icon/title changes call this too, the same cross-model shape
   * `models/glossary.ts#invalidateCache` already establishes for `deletePage`/`deleteOrphaned`
   * (OpenProject #870).
   */
  invalidateCache(siteId: string): void {
    const keys = this.cacheKeysBySite.get(siteId)
    if (!keys) {
      return
    }
    for (const key of keys) {
      WIKI.cache.delete(key)
    }
    this.cacheKeysBySite.delete(siteId)
  }

  /**
   * Build a menu by walking the tree instead of reading a hand-authored `items` row — the `auto` /
   * `mixed` navigation source modes this feature adds. Called from `getNav` via `resolveGeneratorRoot`,
   * which is what picks `rootFolderPath`/`locale` for a given menu id.
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
   * `actor` (OpenProject #2155): each candidate is also checked against `read:pages` — a page with its
   * own tags/classification, a folder with neither (same treatment `helpers/pageAccess.ts#mayOnFolder` gives a
   * folder) — the same permission a direct tree browse or page read already enforces, which this walk
   * had never asked before. A denied row is dropped outright rather than merely hidden from its own
   * subtree, so a DENY over a branch hides the branch without ever querying below it — the recursive
   * short-circuit `tree.ts` documents for the same rule. A non-boundary folder that recurses to zero
   * remaining children (every descendant denied individually, even though `holdsVisiblePages` found at
   * least one browsable/published page down there) is dropped too, mirroring that same dead-end rule
   * for a folder left with nothing visible under it — `null` skips this entirely, which is what
   * `getNav`'s `unfiltered` read passes, matching how that read already skips `visibilityGroups`
   * filtering for the same "the editor needs to see the real generated structure" reason.
   *
   * @param rootFolderPath Encoded ltree path of the folder whose contents this builds a menu from —
   *                        empty at the site root, exactly what `tree.browse()` calls `encodedPath`.
   * @param actor Who is asking, or `null` to skip the `read:pages` check entirely (an `unfiltered`
   *              read).
   * @param depth How many folder levels below `rootFolderPath` this call already is. Callers always
   *              start at 0; recursion stops past the same `MAX_DEPTH` `tree.ts` enforces elsewhere.
   */
  private async generateFromTree(
    siteId: string,
    rootFolderPath: string,
    locale: string,
    actor: AccessActor | null,
    depth = 0
  ): Promise<NavigationItem[]> {
    if (depth > MAX_DEPTH) {
      return []
    }

    // -> Literally the same subquery `tree.browse()` runs, now that it is one function (its own doc
    //    comment carries the reasoning); the alias suffix only keeps the two from colliding if a future
    //    statement ever carries both.
    const holdsVisiblePages = holdsVisiblePagesUnder(rootFolderPath, true, 'NavGen')

    const rows = await WIKI.db
      .select({
        id: treeTable.id,
        type: treeTable.type,
        fileName: treeTable.fileName,
        title: treeTable.title,
        icon: pagesTable.icon,
        navigationMode: treeTable.navigationMode,
        holdsVisiblePages: sql<boolean>`${holdsVisiblePages}`.mapWith(Boolean),
        // -> Only ever populated for a page row (the left-join's page-side columns), which is all
        //    `read:pages`'s tag/classification axes ever need -- a folder carries neither of its own,
        //    same treatment `helpers/pageAccess.ts#mayOnFolder` gives it.
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
    const locales = WIKI.sites[siteId]?.config?.locales

    const candidates = rows
      // -> An empty folder is a dead end -- same as `browse()` drops it
      .filter((row) => row.type !== 'folder' || row.holdsVisiblePages)
      // -> Dropped outright, and -- for the recursive `hide` -- everything below it along with it,
      //    since nothing below a row that was never added is ever walked
      .filter((row) => !(['hide', 'hideExact'] as NavigationMode[]).includes(row.navigationMode))
      // -> OpenProject #2155: the `read:pages` gate itself. `null` (an `unfiltered` read) skips it
      //    entirely, same as the `visibilityGroups` pass in `getNav` does for that read. A folder
      //    carries no tags/classification of its own -- same treatment `helpers/pageAccess.ts#mayOnFolder`
      //    gives it -- so only a page row's real values narrow a TAG/TAGALL/CLASSIFICATION rule.
      .filter((row) => {
        if (!actor) {
          return true
        }
        const path = parentPath ? `${parentPath}/${row.fileName}` : row.fileName
        return WIKI.models.groups.checkAccess(actor, 'read:pages', {
          path,
          siteId,
          locale,
          tags: row.tags ?? [],
          classification: row.classification ?? null
        })
      })
      .sort((a, b) =>
        compareFoldersFirst(
          { isFolder: a.type === 'folder', title: a.title },
          { isFolder: b.type === 'folder', title: b.title }
        )
      )

    const built = await Promise.all(
      candidates.map(async (row): Promise<NavigationItem | null> => {
        // -> The `read:pages` check itself already ran in the `candidates` filter above, per
        //    candidate -- this only needs the same path string again, for `target:` below.
        const path = parentPath ? `${parentPath}/${row.fileName}` : row.fileName

        // -> Only a folder has descendants to walk; a page is always a leaf here regardless of its own
        //    mode, since `override`/`overrideExact` only matters where there is a subtree to stop at
        const isFolder = row.type === 'folder'
        const isBoundary =
          isFolder &&
          (['override', 'overrideExact'] as NavigationMode[]).includes(row.navigationMode)
        const childFolderPath = rootFolderPath ? `${rootFolderPath}.${row.fileName}` : row.fileName
        const children =
          isFolder && !isBoundary
            ? await this.generateFromTree(siteId, childFolderPath, locale, actor, depth + 1)
            : []

        // -> A non-boundary folder that recursed to nothing is a dead end just like an empty folder
        //    is at the SQL layer above (`holdsVisiblePages`) -- the difference is this one can only
        //    happen once `actor` is filtering individual descendants out one by one, since
        //    `holdsVisiblePages` already guarantees at least one browsable/published page exists
        //    somewhere below. Drop it rather than emit a folder link with nowhere to go.
        if (isFolder && !isBoundary && children.length === 0) {
          return null
        }

        return {
          id: row.id,
          type: 'link',
          label: row.title,
          ...(row.icon && { icon: row.icon }),
          // -> Prefixes the locale only when the site's routing rules call for it
          //    (`localizedPagePath`), matching how `NavItemEditor.vue`'s manual page-picker builds a
          //    link target, so a generated item and a hand-picked one render identically on the frontend
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
    assertValidNavItems(items)
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
    this.invalidateCache(siteId)
  }

  /**
   * Copy one menu's items onto another, addressed by id exactly like `setNavItems` — the caller
   * already knows both rows, whether that's a same-site "copy from locale" or a genuinely cross-site
   * copy (`sourceSiteId` and `targetSiteId` differ).
   *
   * Reads the source's raw, unfiltered items (the same shape `getNav(..., { unfiltered: true })`
   * returns — an editor copying a menu needs every item, not just what the requester's own groups can
   * see), deep-clones them with a fresh id on every item so the sortable list frontend's `id`-keyed
   * drag state never collides between source and target, and either overwrites the target's items
   * (`replace`) or pushes the clones onto whatever the target already has (`append`, matching 2.5.x's
   * "copy from locale" merge behavior).
   *
   * `visibilityGroups` travels over unchanged — groups are instance-wide, so a group reference from
   * the source site/locale is still valid on the target. A safe item `target` (a rooted path or a
   * complete `http(s)`/`mailto`/`tel` target) is copied unrewritten: repointing it against the
   * destination locale/site is a known best-effort limitation, same as 2.5.x. An UNSAFE one
   * (`javascript:` and friends — see `isValidNavItemTarget` above) is stripped rather than carried
   * over (OpenProject #1360/#2208/#2217), so a source menu poisoned before this validation existed,
   * or one written straight to the database, cannot be reintroduced onto a clean target this way.
   *
   * @param sourceSiteId Site the source row belongs to — the same as `targetSiteId` for a same-site
   *                      "copy from locale", different for a cross-site copy
   * @param sourceId The source row's own id
   * @param targetSiteId Site the target row belongs to — always the path's `:siteId` from the route
   * @param targetId The target row's own id
   */
  async copyNav({
    sourceSiteId,
    sourceId,
    targetSiteId,
    targetId,
    mode
  }: {
    sourceSiteId: string
    sourceId: string
    targetSiteId: string
    targetId: string
    mode: NavCopyMode
  }): Promise<void> {
    const sourceRows = await WIKI.db
      .select({ items: navigationTable.items })
      .from(navigationTable)
      .where(and(eq(navigationTable.id, sourceId), eq(navigationTable.siteId, sourceSiteId)))
      .limit(1)
    const sourceRow = sourceRows[0]
    if (!sourceRow) {
      throw new CustomError('navCopySourceNotFound', 'The source menu does not exist.', 404)
    }

    const targetRows = await WIKI.db
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

    await WIKI.db.update(navigationTable).set({ items }).where(eq(navigationTable.id, targetId))
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
   * Public so `TreeModel#addEntry` can resolve a new or moved page's `navigationId` from its
   * folder ancestry at insert time, rather than defaulting it to the site-wide menu.
   *
   * @param siteId Site the entry belongs to, since paths are only unique within one
   * @param locale Locale the entry belongs to — an ancestor override in a different locale that
   *               happens to share the same path is not this entry's ancestor
   * @param folderPath Encoded ltree path of the folder holding the entry, empty at the site root
   */
  async ancestorNavId(siteId: string, locale: string, folderPath: string): Promise<string | null> {
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
   * `mode` here is the entry's cascade setting (`inherit`/`override`/`overrideExact`/`hide`/
   * `hideExact` — `NavigationMode`, deciding WHICH menu a page's sidebar resolves to). `menuMode` is a
   * different axis entirely: the resolved menu ROW's own `mode` column (`static`/`auto`/`mixed` —
   * `NavigationSourceMode`, deciding whether that menu's items are hand-authored, tree-generated, or
   * both — see `getNav`). The two can change independently of each other in the same call, which is
   * why they are separate parameters rather than one being folded into the other.
   *
   * @param items When given, the menu the mode resolves to, replacing whatever was there — this
   *              entry's own, or the one it inherits when the mode is `inherit`
   * @param menuMode When given, the resolved menu row's own `mode` (`static`/`auto`/`mixed`),
   *                 replacing whatever it already had — set on the same target row `items` would
   *                 write to (`ancestorId` under `inherit`, `ownNavId` otherwise), independent of
   *                 whether `items` is also given.
   */
  async updateNavigation({
    siteId,
    pageId,
    mode,
    items,
    menuMode
  }: {
    siteId: string
    pageId: string
    mode: NavigationMode
    items?: NavigationItem[]
    menuMode?: NavigationSourceMode
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
      assertValidNavItems(items)
    }

    if (items || menuMode) {
      /*
        Which menu the items (and/or menuMode) belong to is the mode's answer, not the entry's: a page
        that inherits shows a menu belonging to an ancestor, so editing the sidebar from that page edits
        THAT menu rather than starting one of its own that nothing would point at. For the root home
        page the two are the same id — the site-wide menu is what it inherits and what it owns.
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
      await WIKI.db
        .insert(navigationTable)
        .values({
          id: targetNavId,
          siteId,
          items: items ?? [],
          ...(menuMode && { mode: menuMode })
        })
        .onConflictDoUpdate({ target: navigationTable.id, set })
    }

    /*
      `override`/`overrideExact` always point `tree.navigationId` at `ownNavId` below, whether or not
      THIS call is also writing items -- the FK on `tree.navigationId` (db/migrations/
      20260825202930_main) means that row has to actually exist first. The block above only creates
      it when `items`/`menuMode` was given; a bare mode switch (an editor toggling a page to
      `override` before ever touching its sidebar) reaches here with neither, so ensure the row on
      its own. `onConflictDoNothing` is what keeps this a no-op once the row is real -- either from
      the block above in this same call, or from an earlier one -- rather than clobbering its items.
    */
    if ((mode === 'override' || mode === 'overrideExact') && !(items || menuMode)) {
      await WIKI.db
        .insert(navigationTable)
        .values({ id: ownNavId, siteId, items: [] })
        .onConflictDoNothing()
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
      //    which owns its own subtree. The boundary paths (the ltree concat that decides what
      //    counts as "under" a boundary) are collected once into a CTE rather than recomputed by a
      //    correlated NOT EXISTS on every candidate row — same boundary set, same containment
      //    predicate, evaluated per boundary instead of per row.
      await WIKI.db.execute(sql`
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

    // -> Whatever changed above -- items, menuMode, or just the entry's own cascade mode -- can alter
    //    what a generated menu's tree walk returns (a `navigationMode` flip changes whether
    //    `generateFromTree` treats this entry as a boundary, hidden, or an ordinary walked node), so
    //    every cached menu for the site is dropped rather than trying to name just the affected ones
    this.invalidateCache(siteId)

    return { navigationMode: mode, navigationId: navId, ...(menuMode && { mode: menuMode }) }
  }
}

export const navigation = new Navigation()
