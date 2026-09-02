import { normalizeMigratedPath } from './path-normalization.ts'
import type { StagedNavigation } from './content-staging.ts'
import type { NavigationItem } from '../models/navigation.ts'

/**
 * Navigation import as the site-wide menu (Feature 416 / Task 741)
 *
 * Turns the single `StagedNavigation` row Task 733's staging pass produced (2.x's `navigation.key` /
 * `config` JSON, carried through verbatim — see that module's own doc comment) into 3.0's site-wide
 * menu.
 *
 * Like every module in this feature, this one has no db access of its own — `NavigationWriteModel` is
 * injected, and its two methods are `WIKI.models.navigation`'s own `ensureSiteNav(siteId, locale)` and
 * `setNavItems(siteId, navId, items)` rather than a reinvented write path. Writing through those two,
 * rather than driving `updateNavigation()`, is deliberate: that method requires an actual tree entry
 * (a `pageId`) to resolve `mode`/`ancestorId` against, and a fresh import has no reason to require one
 * to exist first. `phases/content.ts` supplies the real implementations (dry-run-gated).
 *
 * ## Link-target conversion
 *
 * 2.x's nav item shape (`server/graph/schemas/navigation.graphql` in the vendored 2.x source) is
 * `{id, kind, label, icon, targetType, target, visibilityMode, visibilityGroups}`, flat — 2.x
 * navigation has no nested children at all, so nothing here ever produces `NavigationItem.children`.
 * `targetType` is 2.x's actual link-syntax discriminator (confirmed against
 * `client/components/admin/admin-navigation.vue`), not the string `target` alone:
 *
 *   - `'home'` → 3.0 `target: '/'` (the same convention 3.0's own `NavEditOverlay` uses for a freshly
 *     added link, confirmed by reading it — no separate "home" concept survives on the 3.0 side).
 *   - `'external'` / `'externalblank'` → `target` carried through as-is; `externalblank` sets
 *     `openInNewWindow: true`, matching what `NavSidebar.vue`'s `destination()` reads that flag for.
 *   - `'page'` → 2.x stores this as `/${locale}/${path}` (`admin-navigation.vue`'s
 *     `selectPageHandle`); 3.0's own link picker (`LinkPickerDialog.vue`) instead writes a bare
 *     `/${path}` with no locale segment at all (confirmed by reading it — `NavSidebar.vue`'s
 *     `destination()`/`routableHref` never re-adds one), so the locale prefix is stripped and the
 *     remaining path is re-normalized through Task 736's `normalizeMigratedPath` (the same function
 *     `page-import.ts` uses to place the page in the tree, so the two agree on the result).
 *   - `'search'` → dropped. 3.0's `NavigationItem` has no saved-search-link concept at all (2.x's own
 *     admin UI had already stopped offering it as of the vendored version — `navTypes` in
 *     `admin-navigation.vue` comments it out — so this only matters for data written by an older 2.x).
 *   - anything else unrecognized → dropped, with a warning naming what was seen.
 *
 * Per this task's description, a `'page'`-type link whose target page did not survive Task 738's
 * import — never staged in the first place, staged but failed to place in the tree, or failed
 * `createPage()` outright — is **dropped**, not left pointing at nothing, and reported by title/target
 * in `NavigationImportResult.dropped` rather than silently disappearing.
 *
 * ## What this module deliberately does not do
 *
 * `visibilityGroups` on a 2.x item restricted to specific groups names 2.x integer group ids. There is
 * no group-id map on this branch (#414's own old-id -> new-UUID map for groups doesn't exist here yet,
 * same gap `content-staging.ts` and `page-import.ts` already documented for users), so a restricted item is
 * imported visible to everyone with a warning naming the gap, on the same reasoning
 * `describePrivacyWarning` in `page-import.ts` used for `isPrivate`/`privateNS`: importing it more
 * open than the source, with a clear note, is preferable to either dropping the whole item or silently
 * keeping a restriction nothing can resolve.
 *
 * Per this task's explicit instruction, nothing here synthesizes a 3.0 `tree.navigationMode` override
 * for any page. That is inherently satisfied by construction, not just by omission: this module never
 * touches the `tree` table at all, only `navigation.items` — every imported page keeps whatever
 * `navigationMode` `createPage()` gave it, which is 3.0's own default, `'inherit'`.
 */

/** The subset of `WIKI.models.navigation` this module actually calls, with the same signatures the
 * real model has — see the module doc comment for why these two calls in particular, and not a
 * hand-written insert. */
export interface NavigationWriteModel {
  /** Resolves (creating if absent) the site-wide menu row for one locale, returning its id. */
  ensureSiteNav(siteId: string, locale: string): Promise<string>
  setNavItems(siteId: string, navId: string, items: NavigationItem[]): Promise<void>
}

export interface NavigationImportDeps {
  navigationModel: NavigationWriteModel
}

/** The minimal shape this module needs from a staged page to resolve a 2.x `'page'`-type nav target —
 * deliberately a subset of `StagedPage` (see `content-staging.ts`) rather than an import of that
 * module's full type, so this one stays a plain consumer of any `{oldId, path, locale}`-shaped row. */
export interface NavigationPageRef {
  oldId: number
  path: string
  locale: string
}

export interface NavigationImportOptions {
  /** The 3.0 site whose root menu this writes. */
  siteId: string
  /** Which one of 2.x's per-locale trees becomes 3.0's single, locale-less site-wide menu — see the
   * module doc comment. The caller (Task 421's CLI) is expected to pass the target site's own primary
   * locale (`WIKI.sites[siteId].config.locales.primary`); this module has no `WIKI` access to default
   * it itself. */
  locale: string
}

export interface DroppedNavigationItem {
  /** The 2.x item's own label, or `'(untitled)'` when it had none — reported by title/target per this
   * task's description. */
  title: string
  /** The 2.x item's raw `target` string, verbatim, for the operator report. */
  target: string
  reason: string
}

export interface NavigationImportResult {
  /** The mapped 3.0 items actually written as the site's root menu. */
  items: NavigationItem[]
  dropped: DroppedNavigationItem[]
  warnings: string[]
}

const KIND_MAP: Record<string, 'link' | 'header' | 'separator'> = {
  link: 'link',
  header: 'header',
  divider: 'separator'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// -> Mirrors `frontend/src/components/shared/WIcon.vue`'s `ICONIFY_REF` exactly: that component is
//    what ultimately renders `item.icon`, and returns `kind: 'none'` (blank) for anything not
//    matching this shape or an `img:` prefix. Kept in sync by inspection rather than a shared import
//    — frontend and backend are separate workspaces with no shared module between them.
const ICONIFY_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-.][a-z0-9]+)*$/

/**
 * Translates a 2.x icon value into the Iconify `prefix:name` reference 3.0 renders, or `null` when
 * it cannot be carried across.
 *
 * 2.x's navigation editor stored a Material Design Icons *webfont class* (`mdi-home`;
 * `mdi-chevron-right` was the default for a new item), never an Iconify reference — so the common
 * case is a mechanical `mdi-<name>` → `mdi:<name>` prefix swap, which resolves through `/_icons`
 * exactly as an author-picked `mdi:` icon does elsewhere in 3.0. An already-Iconify-shaped value (an
 * item created by a build of 3.0's own nav editor, however unlikely on data staged from 2.x) passes
 * through untouched. Anything else — 2.x's picker allowed any Vuetify/MDI webfont class, and a name
 * the Iconify `mdi` set doesn't carry still resolves to nothing — is dropped; the caller is
 * responsible for warning, since only it knows the item's title for the message.
 */
function translateIcon(raw: string): string | null {
  if (ICONIFY_REF.test(raw)) {
    return raw
  }
  const mdiMatch = /^mdi-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(raw)
  if (mdiMatch) {
    const candidate = `mdi:${mdiMatch[1]}`
    return ICONIFY_REF.test(candidate) ? candidate : null
  }
  return null
}

function pageLookupKey(locale: string, path: string): string {
  return `${locale}::${path}`
}

/**
 * Picks which locale's tree out of 2.x's `navigation.config` becomes 3.0's single site-wide menu.
 * Handles both shapes `config` can hold, per 2.x's own `Navigation.getTree()` (vendored source):
 *
 *   - the "pre-2.3" format: a flat array of items, each already carrying a `kind` — no per-locale
 *     wrapper, implicitly a single `'en'` tree.
 *   - the modern format `updateTree()`'s mutation writes: `[{locale, items}, ...]`.
 *
 * Returns an empty array (with a warning) when `config` holds the modern format but none of its
 * entries match `locale`.
 */
export function extractLocaleItems(config: unknown, locale: string, warnings: string[]): unknown[] {
  if (!Array.isArray(config) || config.length === 0) {
    return []
  }
  const first = config[0]
  if (isRecord(first) && 'kind' in first) {
    return config
  }
  const trees = config.filter(isRecord)
  const match = trees.find((tree) => tree.locale === locale)
  if (!match) {
    const available = trees.map((tree) => String(tree.locale)).join(', ') || '(none)'
    warnings.push(
      `navigation: no 2.x tree found for locale "${locale}" (available: ${available}) — imported an empty site menu.`
    )
    return []
  }
  return Array.isArray(match.items) ? match.items : []
}

/** A 2.x `'page'`-type nav target, `/${locale}/${path}` (`admin-navigation.vue`'s
 * `selectPageHandle`), split back into its parts — or `null` if `target` does not match that shape,
 * or if the leading segment isn't one of `knownLocales`. That set comes from the import's own staged
 * pages (see `importNavigation`), not the target site's `active` list: validating against the site
 * being imported *into* would wrongly drop targets for locales that are themselves mid-import, while
 * the staged-page keys are exactly the 2.x locales this import actually saw. */
function parsePageTarget(
  target: string,
  knownLocales: Set<string>
): { locale: string; path: string } | null {
  const match = /^\/([^/]+)\/(.+)$/.exec(target)
  if (!match) return null
  const [, locale, path] = match
  if (!knownLocales.has(locale)) return null
  return { locale, path }
}

interface MapItemContext {
  pages: Map<string, NavigationPageRef>
  knownLocales: Set<string>
  pageIdMap: Map<number, string>
  warnings: string[]
  dropped: DroppedNavigationItem[]
}

/**
 * Maps one 2.x nav item (already unwrapped from its locale tree by `extractLocaleItems`) onto a 3.0
 * `NavigationItem`, or `null` when it cannot be carried across — every drop is also pushed onto
 * `ctx.dropped`, per this task's "report by title/target" instruction.
 */
export function mapNavigationItem(raw: unknown, ctx: MapItemContext): NavigationItem | null {
  if (!isRecord(raw)) {
    ctx.warnings.push(`navigation: skipped an item that was not an object: ${JSON.stringify(raw)}`)
    return null
  }

  const label = typeof raw.label === 'string' ? raw.label : ''
  const title = label || '(untitled)'
  const id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID()
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  const type = KIND_MAP[kind]
  const rawTarget = typeof raw.target === 'string' ? raw.target : ''

  if (!type) {
    ctx.dropped.push({
      title,
      target: rawTarget,
      reason: `unrecognized 2.x nav item kind "${kind}"`
    })
    return null
  }

  const item: NavigationItem = { id, type }
  if (label) item.label = label
  if (typeof raw.icon === 'string' && raw.icon) {
    const icon = translateIcon(raw.icon)
    if (icon) {
      item.icon = icon
    } else {
      ctx.warnings.push(
        `navigation item "${title}": dropped 2.x icon "${raw.icon}" — not a Material Design Icons ` +
          'webfont class or Iconify reference this import can translate; item was imported with no icon.'
      )
    }
  }

  if (
    raw.visibilityMode === 'restricted' &&
    Array.isArray(raw.visibilityGroups) &&
    raw.visibilityGroups.length > 0
  ) {
    ctx.warnings.push(
      `navigation item "${title}": restricted to 2.x group ids [${raw.visibilityGroups.join(', ')}], ` +
        'which have no 3.0 group-id mapping on this branch (#414) — imported visible to everyone ' +
        'instead of dropped; add the equivalent visibility restriction by hand once #414 lands.'
    )
  }

  if (type !== 'link') {
    return item
  }

  const targetType = typeof raw.targetType === 'string' ? raw.targetType : ''

  switch (targetType) {
    case 'home': {
      item.target = '/'
      return item
    }
    case 'external': {
      item.target = rawTarget
      return item
    }
    case 'externalblank': {
      item.target = rawTarget
      item.openInNewWindow = true
      return item
    }
    case 'page': {
      const parsed = parsePageTarget(rawTarget, ctx.knownLocales)
      if (!parsed) {
        ctx.dropped.push({
          title,
          target: rawTarget,
          reason:
            `malformed page target "${rawTarget}" (expected "/<locale>/<path>", where <locale> is ` +
            'a locale present in this import)'
        })
        return null
      }
      const ref = ctx.pages.get(pageLookupKey(parsed.locale, parsed.path))
      if (!ref) {
        ctx.dropped.push({
          title,
          target: rawTarget,
          reason:
            `no staged page matches locale "${parsed.locale}" path "${parsed.path}" — dropped ` +
            'rather than left dangling'
        })
        return null
      }
      const newPageId = ctx.pageIdMap.get(ref.oldId)
      if (!newPageId) {
        ctx.dropped.push({
          title,
          target: rawTarget,
          reason:
            `page ${ref.oldId} ("${parsed.path}", locale "${parsed.locale}") failed to import — ` +
            'dropped rather than left dangling'
        })
        return null
      }
      const normalized = normalizeMigratedPath(ref.path)
      if ('reason' in normalized) {
        // -> Not reachable in practice: a page whose path fails to normalize never reaches
        //    createPage() (Task 738), so it could never have earned a pageIdMap entry above. Guarded
        //    rather than assumed, since this module has no other way to recover the 3.0 path.
        ctx.dropped.push({
          title,
          target: rawTarget,
          reason: `page ${ref.oldId} imported but its path could not be re-normalized: ${normalized.message}`
        })
        return null
      }
      item.target = `/${normalized.path}`
      return item
    }
    case 'search': {
      ctx.dropped.push({
        title,
        target: rawTarget,
        reason: '3.0 has no saved-search nav link (2.x targetType "search")'
      })
      return null
    }
    default: {
      ctx.dropped.push({
        title,
        target: rawTarget,
        reason: `unrecognized 2.x nav targetType "${targetType}"`
      })
      return null
    }
  }
}

/**
 * Imports 2.x's staged navigation as `options.siteId`'s site-wide menu, per this task's description.
 * Always writes — `ensureSiteNav` then `setNavItems`, even with an empty `items` array when there
 * was nothing to import — so a run always leaves the site with a real (if empty) root menu row.
 */
export async function importNavigation(
  staged: StagedNavigation[],
  pages: NavigationPageRef[],
  pageIdMap: Map<number, string>,
  deps: NavigationImportDeps,
  options: NavigationImportOptions
): Promise<NavigationImportResult> {
  const warnings: string[] = []
  const dropped: DroppedNavigationItem[] = []

  const row = staged.find((n) => n.key === 'site') ?? staged[0]
  if (staged.length > 1) {
    warnings.push(
      `navigation: found ${staged.length} 2.x navigation rows (keys: ${staged
        .map((n) => n.key)
        .join(', ')}) — imported "${row?.key}", the rest ignored (2.x only ever writes a single ` +
        '"site" row in practice).'
    )
  }

  const rawItems = row ? extractLocaleItems(row.items, options.locale, warnings) : []

  const pageByKey = new Map(pages.map((page) => [pageLookupKey(page.locale, page.path), page]))
  // -> The 2.x locales this import actually saw, not the target site's `active` list — see
  //    `parsePageTarget`'s doc comment for why.
  const knownLocales = new Set([...pageByKey.keys()].map((key) => key.split('::')[0]!))
  const ctx: MapItemContext = { pages: pageByKey, knownLocales, pageIdMap, warnings, dropped }

  const items: NavigationItem[] = []
  for (const raw of rawItems) {
    const mapped = mapNavigationItem(raw, ctx)
    if (mapped) items.push(mapped)
  }

  const navId = await deps.navigationModel.ensureSiteNav(options.siteId, options.locale)
  await deps.navigationModel.setNavItems(options.siteId, navId, items)

  return { items, dropped, warnings }
}
