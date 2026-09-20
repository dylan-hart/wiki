import { and, eq, like } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import { pages } from '../../models/pages.ts'
import { jobs } from '../../models/jobs.ts'
import { convertTiptapJsonToMarkdown } from '../../helpers/wysiwygHeadlessMarkdown.ts'
import type { TaskResult } from '../../core/scheduler.ts'

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
 * A legacy WYSIWYG row stores raw serialized ProseMirror JSON as `content` while labeling it
 * `contentType: 'html'`. A `code`-editor page carries `contentType: 'html'` too, and real HTML never
 * starts with `{` -- the one thing that tells the two apart at the row level, and what the `like`
 * filter below is doing.
 *
 * A row that cannot be converted -- malformed JSON, or JSON that is not a Tiptap document -- goes
 * into the report's `failed` list and the run carries on: one bad row must not stop the rest being
 * cleaned up. `jobId` is this task's own `jobHistory` row, and recording the report on it is what
 * lets `GET /_api/system/wysiwyg/convert/:jobId` poll for it.
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
      // -> The row's own last author, not whoever queued this run: a re-encoding, not a new edit.
      const converted = await pagesDep.convertLegacyWysiwygRow(
        row.siteId,
        row.id,
        markdown,
        row.authorId
      )
      if (converted) {
        report.convertedCount++
      } else {
        // -> No longer the shape the `SELECT` read: converted since, by a concurrent run or by
        //    someone opening the page. Not a failure -- there is nothing left to convert.
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
