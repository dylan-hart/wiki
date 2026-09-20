import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { pages as pagesTable, pageHistory as pageHistoryTable } from '../../db/schema.ts'
import { task } from './convert-wysiwyg-json.ts'

describe('convert-wysiwyg-json.task (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('../../models/pages.ts').pages

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('../../models/pages.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Raw insert, satisfying every NOT NULL column: `createPage()` cannot produce these shapes. */
  function rawPageRow(overrides: {
    path: string
    content: string
    editor?: string
    contentType?: string
  }) {
    return {
      locale: 'en',
      hash: `hash-${overrides.path}`,
      title: 'Raw Row',
      editor: 'wysiwyg',
      contentType: 'html',
      authorId: fixtures.userId,
      creatorId: fixtures.userId,
      ownerId: fixtures.userId,
      siteId: fixtures.siteId,
      classification: fixtures.classificationId,
      ...overrides
    }
  }

  beforeEach(async () => {
    // -> The task walks the whole `pages` table, so distinct paths are not enough isolation: a row a
    //    test failed to convert stays behind and the next run picks it up again.
    await fixtures.db.delete(pageHistoryTable)
    await fixtures.db.delete(pagesTable)
  })

  test('converts a valid legacy row, leaves a real code-editor HTML row and a markdown row untouched, and reports a malformed one as failed rather than skipping it', async () => {
    const validId = (
      await fixtures.db
        .insert(pagesTable)
        .values(
          rawPageRow({
            path: 'docs/convert-valid',
            content: JSON.stringify({
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }]
            })
          })
        )
        .returning({ id: pagesTable.id })
    )[0]!.id

    const malformedId = (
      await fixtures.db
        .insert(pagesTable)
        .values(rawPageRow({ path: 'docs/convert-malformed', content: '{not valid json' }))
        .returning({ id: pagesTable.id })
    )[0]!.id

    const notADocId = (
      await fixtures.db
        .insert(pagesTable)
        .values(rawPageRow({ path: 'docs/convert-not-a-doc', content: '{"foo":"bar"}' }))
        .returning({ id: pagesTable.id })
    )[0]!.id

    const codeEditorId = (
      await fixtures.db
        .insert(pagesTable)
        .values(
          rawPageRow({
            path: 'docs/convert-real-html',
            editor: 'code',
            content: '<p>Real HTML, not JSON</p>'
          })
        )
        .returning({ id: pagesTable.id })
    )[0]!.id

    const markdownId = (
      await fixtures.db
        .insert(pagesTable)
        .values(
          rawPageRow({
            path: 'docs/convert-already-markdown',
            editor: 'markdown',
            contentType: 'markdown',
            content: '# Already markdown'
          })
        )
        .returning({ id: pagesTable.id })
    )[0]!.id

    const setResult = mock.fn(async (_id: string, _result: any) => {})
    const result = await task({}, 'job-1', { pages: pagesModel, jobs: { setResult } as any })

    assert.equal(result.summary, 'converted legacy WYSIWYG JSON rows')
    assert.equal(result.converted, 1)
    assert.equal(result.failed, 2)

    assert.equal(setResult.mock.calls.length, 1)
    const [, report] = setResult.mock.calls[0]!.arguments as [string, any]
    assert.equal(report.convertedCount, 1)
    assert.equal(report.failed.length, 2)
    const failedIds = report.failed.map((f: any) => f.id).sort()
    assert.deepEqual(failedIds, [malformedId, notADocId].sort())
    for (const failure of report.failed) {
      assert.equal(typeof failure.reason, 'string')
      assert.ok(failure.reason.length > 0)
    }

    const rows = await fixtures.db
      .select({
        id: pagesTable.id,
        content: pagesTable.content,
        contentType: pagesTable.contentType
      })
      .from(pagesTable)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

    assert.equal(byId[validId]!.contentType, 'markdown')
    assert.equal(byId[validId]!.content, 'Hi')

    assert.equal(byId[malformedId]!.contentType, 'html')
    assert.equal(byId[notADocId]!.contentType, 'html')
    assert.equal(byId[codeEditorId]!.contentType, 'html')
    assert.equal(byId[codeEditorId]!.content, '<p>Real HTML, not JSON</p>')
    assert.equal(byId[markdownId]!.contentType, 'markdown')
    assert.equal(byId[markdownId]!.content, '# Already markdown')

    const history = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.pageId, validId))
    assert.equal(history.length, 1)
  })

  test('a run with nothing to convert reports zero converted, zero failed, and still calls setResult', async () => {
    const setResult = mock.fn(async (_id: string, _result: any) => {})
    const result = await task({}, 'job-2', { pages: pagesModel, jobs: { setResult } as any })

    assert.equal(result.converted, 0)
    assert.equal(result.failed, 0)
    assert.equal(setResult.mock.calls.length, 1)
    const [, report] = setResult.mock.calls[0]!.arguments as [string, any]
    assert.deepEqual(report, { convertedCount: 0, failed: [] })
  })

  test('omitting jobId skips setResult entirely, without throwing', async () => {
    const result = await task({}, undefined, { pages: pagesModel })
    assert.equal(typeof result.converted, 'number')
  })
})
