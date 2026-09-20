import { normalizeMigratedPath } from '../path-normalization.ts'
import type { StagedNavigation } from '../content-staging.ts'
import type { NavigationItem } from '../../models/navigation.ts'

/**
 * 2.x navigation is flat, so nothing here produces `NavigationItem.children`.
 *
 * A 2.x `'page'` target is `/${locale}/${path}`; a 3.0 nav target carries no locale segment, so the
 * prefix is stripped and the path re-normalized through `normalizeMigratedPath` — the function
 * `page-import.ts` places the page with, so the two agree.
 *
 * `visibilityGroups` names 2.x integer group ids, and no group-id map reaches this module (the
 * `users` phase builds one, but it is not in `NavigationImportDeps`). A restricted item is therefore
 * imported visible to everyone, with a warning — preferable to dropping it or keeping a restriction
 * nothing can resolve.
 */

export interface NavigationWriteModel {
  ensureSiteNav(siteId: string, locale: string): Promise<string>
  setNavItems(siteId: string, navId: string, items: NavigationItem[]): Promise<void>
}

export interface NavigationImportDeps {
  navigationModel: NavigationWriteModel
}

/** A structural subset of `StagedPage` rather than an import of it, so any `{oldId, path, locale}`
 * row satisfies this module. */
export interface NavigationPageRef {
  oldId: number
  path: string
  locale: string
}

export interface NavigationImportOptions {
  siteId: string
  /** Which of 2.x's per-locale trees becomes 3.0's single, locale-less site-wide menu. The caller
   * passes the target site's primary locale; this module has no `CARDINAL` access to default it
   * itself. */
  locale: string
}

export interface DroppedNavigationItem {
  title: string
  target: string
  reason: string
}

export interface NavigationImportResult {
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

// -> Mirrors `WIcon.vue`'s `ICONIFY_REF`, which renders `item.icon` and draws nothing for anything
//    else. Kept in sync by inspection: frontend and backend share no module.
const ICONIFY_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-.][a-z0-9]+)*$/

/**
 * 2.x's navigation editor stored a Material Design Icons *webfont class* (`mdi-home`), never an
 * Iconify reference, so the common case is a mechanical `mdi-<name>` → `mdi:<name>` swap. Any other
 * webfont class its picker allowed resolves to nothing in 3.0 and yields `null`; the caller warns,
 * since only it knows the item's title.
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
 * Both shapes 2.x's `navigation.config` can hold:
 *
 *   - pre-2.3: a flat array of items, each already carrying a `kind`, with no per-locale wrapper.
 *   - since 2.3: `[{locale, items}, ...]`.
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

/** Splits a 2.x `'page'`-type nav target, `/${locale}/${path}`, back into its parts.
 * `knownLocales` is the locale set of the import's own staged pages, not the target site's `active`
 * list: validating against the site being imported *into* would wrongly drop targets for locales
 * that are themselves mid-import. */
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
        // -> Unreachable in practice: a page whose path fails to normalize never reaches
        //    createPage(), so it has no pageIdMap entry. Guarded because there is no other way to
        //    recover the 3.0 path.
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

/** Writes unconditionally, even with nothing to import, so a run always leaves the site with a real
 * (if empty) root menu row. */
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
