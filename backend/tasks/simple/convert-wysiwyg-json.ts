import { and, eq, like } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import { pages } from '../../models/pages.ts'
import { jobs } from '../../models/jobs.ts'
import { convertTiptapJsonToMarkdown } from '../../helpers/wysiwygHeadlessMarkdown.ts'
import type { TaskResult } from '../../core/scheduler.ts'

/** One row this run either converted or, when it couldn't, is reporting rather than skipping. */
interface ConversionFailure {
  siteId: string
  id: string
  path: string
  locale: string
  reason: string
}

export interface ConversionReport {
  convertedCount: number
  failed: ConversionFailure[]
}

/**
 * Convert every legacy WYSIWYG row's stored Tiptap JSON into markdown, across every site
 * (OpenProject #3400).
 *
 * The wysiwyg editor stored raw serialized ProseMirror JSON as `content`, labeled `contentType:
 * 'html'` (the content type `EDITOR_CONTENT_TYPES` gave it before #3395 taught the editor to store
 * markdown instead) -- a `code`-editor page also carries `contentType: 'html'`, but real HTML never
 * starts with `{`, which is the one thing that tells the two apart at the row level. Queued from
 * `POST /_api/system/wysiwyg/convert` rather than run inline: converting every such row on a large
 * wiki is not instant, and each is a full read-modify-write plus a history version. `jobId` is this
 * task's own row in `jobHistory` (see `core/scheduler.ts`'s `SimpleTask`) -- recording the report on
 * it is what lets `GET /_api/system/wysiwyg/convert/:jobId` poll for it.
 *
 * A row this can't convert -- malformed JSON, or JSON that isn't a Tiptap document at all -- is
 * recorded in the report's `failed` list, not silently skipped, and every other row keeps going: one
 * bad row must not stop the run-once job from cleaning up the rest. The lazy on-open fallback in
 * `EditorWysiwyg.vue` is what eventually converts whatever this run leaves behind, the next time
 * somebody actually opens one of those pages.
 *
 * @param deps Real models by default; overridable so tests can exercise this without a database (the
 *   same shape `tasks/simple/import-content.ts` uses).
 */
export async function task(
  _payload: { actorId?: string } = {},
  jobId?: string,
  deps: {
    pages?: typeof pages
    jobs?: typeof jobs
  } = {}
): Promise<TaskResult> {
  const { pages: pagesDep = pages, jobs: jobsDep = jobs } = deps

  CARDINAL.logger.debug('pages', 'converting legacy WYSIWYG JSON rows')

  const rows = await CARDINAL.db
    .select({
      id: pagesTable.id,
      siteId: pagesTable.siteId,
      path: pagesTable.path,
      locale: pagesTable.locale,
      content: pagesTable.content,
      authorId: pagesTable.authorId
    })
    .from(pagesTable)
    .where(
      and(
        eq(pagesTable.editor, 'wysiwyg'),
        eq(pagesTable.contentType, 'html'),
        like(pagesTable.content, '{%')
      )
    )

  const report: ConversionReport = { convertedCount: 0, failed: [] }

  for (const row of rows) {
    try {
      const json = JSON.parse(row.content ?? '')
      const markdown = convertTiptapJsonToMarkdown(json)
      // -> The row's own last author, not whoever queued this run -- see `convertLegacyWysiwygRow`'s
      //    doc comment for why this is a re-encoding rather than a new edit.
      const converted = await pagesDep.convertLegacyWysiwygRow(
        row.siteId,
        row.id,
        markdown,
        row.authorId
      )
      if (converted) {
        report.convertedCount++
      } else {
        // -> The row no longer matches the shape the `SELECT` above read -- already converted (by a
        //    concurrent run, or by someone opening it through the lazy fallback) since this task
        //    started. Not a failure: there is nothing left here to convert.
        CARDINAL.logger.debug('pages', 'legacy WYSIWYG row changed shape mid-run, skipping', {
          page: row.id,
          site: row.siteId
        })
      }
    } catch (err: any) {
      report.failed.push({
        siteId: row.siteId,
        id: row.id,
        path: row.path,
        locale: row.locale,
        reason: err.message
      })
    }
  }

  if (jobId) {
    await jobsDep.setResult(jobId, report as unknown as Record<string, any>)
  }

  return {
    summary: 'converted legacy WYSIWYG JSON rows',
    converted: report.convertedCount,
    failed: report.failed.length
  }
}
