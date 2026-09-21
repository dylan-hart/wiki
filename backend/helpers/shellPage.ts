import { and, eq, inArray } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { normalizePagePath } from './common.ts'
import { stripLocalePrefix, type LocaleRoutingConfig } from './localeRouting.ts'
import { rulesAllow } from './pageRules.ts'

export interface ShellPageTranslation {
  locale: string
  path: string
}

export interface ShellPage {
  title: string
  description: string | null
  path: string
  locale: string
  translations: ShellPageTranslation[]
}

const rePagePath = /^[a-zA-Z0-9-_/]*$/

function pagePathFromUrl(urlPath: string, locales: LocaleRoutingConfig | undefined): string | null {
  const stripped = stripLocalePrefix(urlPath, locales)
  let decoded: string
  try {
    decoded = decodeURIComponent(stripped ? stripped.path : urlPath)
  } catch {
    return null
  }
  // -> The root URL addresses the page at path `home`, as `api/pages/read.ts` does
  const path = normalizePagePath(decoded) || 'home'
  return rePagePath.test(path) ? path : null
}

/**
 * Null covers a missing, unpublished, guest-unreadable and password-locked page identically, so the
 * shell tells a crawler nothing a nonexistent path would not; a locked page's title and description
 * in the head would leak what the page API blanks. Deliberately uncached: a cached positive would
 * outlive an unpublish or rule change and keep serving that page's metadata to anonymous readers.
 */
export async function lookupShellPage(input: {
  siteId: string
  urlPath: string
  locale: string
}): Promise<ShellPage | null> {
  const { siteId, urlPath, locale } = input
  const locales = CARDINAL.sites[siteId]?.config?.locales
  const path = pagePathFromUrl(urlPath, locales)
  if (path === null) {
    return null
  }

  const candidateLocales = [
    ...new Set<string>([locale, ...(locales?.active ?? [locales?.primary ?? 'en'])])
  ]
  const rows = await CARDINAL.db
    .select({
      locale: pagesTable.locale,
      path: pagesTable.path,
      title: pagesTable.title,
      description: pagesTable.description,
      tags: pagesTable.tags,
      classification: pagesTable.classification,
      password: pagesTable.password
    })
    .from(pagesTable)
    .where(
      and(
        eq(pagesTable.siteId, siteId),
        eq(pagesTable.path, path),
        inArray(pagesTable.locale, candidateLocales),
        eq(pagesTable.publishState, 'published')
      )
    )

  // -> Same guests-group predicate as `pages.listPagesForSitemap`; keep the two in step
  const guestRules = CARDINAL.models.groups.rulesForGroups([CARDINAL.data.systemIds.guestsGroupId])
  const visible = rows.filter(
    (row) =>
      !row.password &&
      rulesAllow(guestRules, 'read:pages', {
        path: row.path,
        locale: row.locale,
        siteId,
        tags: row.tags,
        classification: row.classification
      })
  )

  const page = visible.find((row) => row.locale === locale)
  if (!page) {
    return null
  }
  return {
    title: page.title,
    description: page.description,
    path: page.path,
    locale: page.locale,
    translations: visible
      .map((row) => ({ locale: row.locale, path: row.path }))
      .sort((a, b) => a.locale.localeCompare(b.locale))
  }
}
