import path from 'node:path'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import type Client from 'ssh2-sftp-client'
import { pages as pagesTable } from '../../../db/schema.ts'
import { extensionForContentType, injectFrontMatter } from '../../../helpers/pageSerialization.ts'
import { ensureDirectory } from './connection.ts'
import type { PageFrontMatterInput } from '../../../helpers/pageSerialization.ts'
import type { StorageTarget } from '../../../models/storage.ts'

const PAGE_BATCH_SIZE = 200

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
 * Keyset-paginated on `id` rather than offset: there is no `.stream()` in this fork's plain
 * `pg`/Drizzle setup, so explicit fixed-size batches are what keep a full-wiki export from holding
 * every page's content in memory at once.
 *
 * Drafts are the exclusion because the `pages` table has no per-page privacy flag — a draft is this
 * schema's "not meant to be public yet". `scheduled` and `published` both export, regardless of
 * their publish window.
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
  return CARDINAL.db
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

export interface PageExportLocaleInfo {
  defaultLocale: string
  /**
   * Whether non-default locales get a path prefix. Site config carries no namespacing toggle of its
   * own — `forcePrefix` answers a different question (whether the *default* locale is prefixed in
   * page URLs, which never applies on export) — so the gate is "does this site actually run more
   * than one locale": `locales.active.length > 1`.
   */
  namespacingEnabled: boolean
}

export function resolveLocaleInfo(
  site: { config?: { locales?: { primary?: string; active?: string[] } } } | undefined
): PageExportLocaleInfo {
  const locales = site?.config?.locales ?? {}
  return {
    defaultLocale: locales.primary ?? 'en',
    namespacingEnabled: (locales.active?.length ?? 0) > 1
  }
}

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
 * A no-op when `pages` isn't in `target.contentTypes.activeTypes` — an admin can turn page sync off
 * for this target independently of the module supporting it at all, and `exportAll` still runs
 * whatever other content types are enabled.
 *
 * `onProgress` fires once per batch written, not per page, so a large export's logging stays
 * bounded; it is never called for a no-op run.
 */
export async function exportPages(
  client: Client,
  target: StorageTarget,
  options: {
    localeInfo?: PageExportLocaleInfo
    fetchBatch?: PageBatchFetcher
    /** Overridable purely so a test can exercise multi-batch pagination without 200 fixture rows. */
    pageSize?: number
    onProgress?: (exportedCount: number) => void
  } = {}
): Promise<void> {
  if (!target.contentTypes.activeTypes.includes('pages')) {
    return
  }

  const localeInfo = options.localeInfo ?? resolveLocaleInfo(CARDINAL.sites[target.siteId])
  const fetchBatch = options.fetchBatch ?? fetchPageBatch
  const pageSize = options.pageSize ?? PAGE_BATCH_SIZE
  const basePath = String(target.config.basePath ?? '').replace(/\/+$/, '')

  let afterId: string | null = null
  let exportedCount = 0
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

    exportedCount += batch.length
    options.onProgress?.(exportedCount)

    afterId = batch[batch.length - 1].id
    if (batch.length < pageSize) {
      break
    }
  }
}
