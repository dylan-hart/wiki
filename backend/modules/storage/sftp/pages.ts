import path from 'node:path'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import type Client from 'ssh2-sftp-client'
import { pages as pagesTable } from '../../../db/schema.ts'
import { extensionForContentType, injectFrontMatter } from '../../../helpers/pageSerialization.ts'
import { ensureDirectory } from './connection.ts'
import type { PageFrontMatterInput } from '../../../helpers/pageSerialization.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Writing a site's pages to an SFTP target as files — the page half of the `exportAll` action. Asset
 * export (Task 523) and wiring this into `exportAll` itself with connection setup and logging
 * (Task 524) are separate, sibling pieces built on top of this.
 */

/** How many rows one batch pulls from Postgres. Fixed rather than tunable: this exists purely to keep
 *  memory bounded on a large wiki, not as a knob anyone needs to turn. */
const PAGE_BATCH_SIZE = 200

/** The columns `exportPages` actually needs off a page row. */
export interface PageExportRow extends PageFrontMatterInput {
  id: string
  locale: string
  path: string
  contentType: string
  content: string | null
}

export type PageBatchFetcher = (params: {
  siteId: string
  afterId: string | null
  pageSize: number
}) => Promise<PageExportRow[]>

/**
 * One page of rows for a site, ordered and keyset-paginated on `id` rather than offset — this table
 * has no `knex`-style `.stream()` in this fork's plain `pg`/Drizzle setup, so a fixed-size, explicit
 * batch is what keeps a full-wiki export from holding every page's content in memory at once.
 *
 * Gate: `publishState !== 'draft'`. 2.5.x excluded `isPrivate` pages from export, a column and
 * concept this fork's `pages` table doesn't have (no per-page privacy flag — see `db/schema.ts`); a
 * draft is the equivalent "not meant to be public yet" state here, so it is what gets excluded in its
 * place. `scheduled` and `published` both export, matching 2.5.x exporting anything not private
 * regardless of its publish window.
 */
async function fetchPageBatch({
  siteId,
  afterId,
  pageSize
}: {
  siteId: string
  afterId: string | null
  pageSize: number
}): Promise<PageExportRow[]> {
  const conditions = [eq(pagesTable.siteId, siteId), ne(pagesTable.publishState, 'draft')]
  if (afterId) {
    conditions.push(gt(pagesTable.id, afterId))
  }
  return WIKI.db
    .select({
      id: pagesTable.id,
      locale: pagesTable.locale,
      path: pagesTable.path,
      contentType: pagesTable.contentType,
      content: pagesTable.content,
      title: pagesTable.title,
      description: pagesTable.description,
      tags: pagesTable.tags,
      createdAt: pagesTable.createdAt,
      updatedAt: pagesTable.updatedAt
    })
    .from(pagesTable)
    .where(and(...conditions))
    .orderBy(asc(pagesTable.id))
    .limit(pageSize)
}

/** What `remotePathForPage` needs to know about the site a page belongs to. */
export interface PageExportLocaleInfo {
  /** `site.config.locales.primary` — the locale that never gets a path prefix. */
  defaultLocale: string
  /**
   * Whether non-default locales get a path prefix at all.
   *
   * This fork's site config has no dedicated "locale namespacing" toggle the way 2.5.x's `lang`
   * config did — `locales: { primary, active, forcePrefix, showMenu }` (see `models/sites.ts`) is the
   * whole of it, and `forcePrefix` answers a different question (whether the *default* locale is
   * also prefixed in page URLs, which never applies here — the default locale is never namespaced on
   * export, per spec). The equivalent gate chosen for export is "does this site actually run more
   * than one locale": `site.config.locales.active.length > 1`. A single-locale site has nothing to
   * disambiguate a prefix from, so every page writes flat regardless of what its `locale` column
   * happens to say; a multi-locale site prefixes every locale but the default, exactly as 2.5.x's
   * namespacing did once turned on.
   */
  namespacingEnabled: boolean
}

/** Derive `PageExportLocaleInfo` from a cached site config (`WIKI.sites[siteId]`). */
export function resolveLocaleInfo(
  site: { config?: { locales?: { primary?: string; active?: string[] } } } | undefined
): PageExportLocaleInfo {
  const locales = site?.config?.locales ?? {}
  return {
    defaultLocale: locales.primary ?? 'en',
    namespacingEnabled: (locales.active?.length ?? 0) > 1
  }
}

/**
 * The path a page is written to on the remote target, relative to the target's `basePath`:
 * `<localeCode>/<path>.<ext>` when namespacing applies and the page isn't in the site's default
 * locale, else plain `<path>.<ext>`. Extension comes from `contentType` via
 * `extensionForContentType` (Task 521's shared helper).
 */
export function remotePathForPage(
  page: Pick<PageExportRow, 'locale' | 'path' | 'contentType'>,
  localeInfo: PageExportLocaleInfo
): string {
  const ext = extensionForContentType(page.contentType)
  const namespaced = localeInfo.namespacingEnabled && page.locale !== localeInfo.defaultLocale
  const base = namespaced ? `${page.locale}/${page.path}` : page.path
  return `${base}${ext}`
}

/**
 * Write every eligible page of a site to an SFTP target, batching reads so a large wiki never sits
 * fully in memory at once.
 *
 * A no-op when `pages` isn't in `target.contentTypes.activeTypes` — an admin can turn page sync off
 * for this target independently of the module supporting it at all, and `exportAll` is expected to
 * still run whatever other content types are enabled.
 *
 * @param client A connected SFTP client, e.g. from `connectSftp`.
 * @param target The site's configured target; `target.config.basePath` is where files land, and
 *   `target.siteId` is which site's pages get exported.
 * @param options.localeInfo Defaults to resolving the real site from `WIKI.sites`; override in tests.
 * @param options.fetchBatch Defaults to a real `WIKI.db` query; override in tests.
 */
export async function exportPages(
  client: Client,
  target: StorageTarget,
  options: {
    localeInfo?: PageExportLocaleInfo
    fetchBatch?: PageBatchFetcher
    /** Overridable purely so a test can exercise multi-batch pagination without 200 fixture rows. */
    pageSize?: number
  } = {}
): Promise<void> {
  if (!target.contentTypes.activeTypes.includes('pages')) {
    return
  }

  const localeInfo = options.localeInfo ?? resolveLocaleInfo(WIKI.sites[target.siteId])
  const fetchBatch = options.fetchBatch ?? fetchPageBatch
  const pageSize = options.pageSize ?? PAGE_BATCH_SIZE
  const basePath = String(target.config.basePath ?? '').replace(/\/+$/, '')

  let afterId: string | null = null
  for (;;) {
    const batch = await fetchBatch({ siteId: target.siteId, afterId, pageSize })
    if (batch.length === 0) {
      break
    }

    for (const page of batch) {
      const remotePath = remotePathForPage(page, localeInfo)
      const remoteDir = path.posix.dirname(remotePath)
      if (remoteDir !== '.') {
        await ensureDirectory(client, basePath, remoteDir)
      }
      const body = injectFrontMatter(page.content, page)
      await client.put(Buffer.from(body, 'utf8'), `${basePath}/${remotePath}`)
    }

    afterId = batch[batch.length - 1].id
    if (batch.length < pageSize) {
      break
    }
  }
}
