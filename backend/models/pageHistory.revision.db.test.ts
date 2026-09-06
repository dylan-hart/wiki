import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pageHistory as pageHistoryTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `models/pageHistory.ts#revisionSummary` (OpenProject #2651) — the `rev N · M changes` the page
 * metadata rail draws, derived per page read from the history table itself.
 *
 * DB-backed rather than mocked because the whole method IS two SQL reads: a `count(*)` and a
 * two-row, `(versionDate DESC, id DESC)`-ordered fetch of the newest sources (now including `via`,
 * OpenProject #2719's MCP provenance badge). A stubbed query builder would only re-describe the
 * statements rather than verify that the count matches the rows present or that the ordering picks
 * the right pair. What it wraps around those reads — the floor of 1, the omitted change count, the
 * line arithmetic, the `via` fallback for a page with no rows left to read one off of — is exercised
 * through the same calls.
 *
 * `pageHistory.pageId` is deliberately not a foreign key (the history of a deleted page outlives the
 * page — see its column note in `db/schema.ts`), so these rows are seeded against a random page id
 * with no `pages` row behind it. That is a real, supported state for this table, not a shortcut.
 */
describe('pageHistory.revisionSummary (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /**
   * Seeds one history row per entry of `contents`, oldest first, each a minute after the last so the
   * `(versionDate DESC, id DESC)` ordering has a real timeline to sort rather than a tie. `via`
   * defaults to `'editor'` for every entry that doesn't name one, matching the column's own default.
   */
  async function seedHistory(
    contents: (string | null)[],
    { via }: { via?: (string | null)[] } = {}
  ): Promise<string> {
    const pageId = crypto.randomUUID()
    const base = Date.UTC(2026, 0, 1, 12, 0, 0)
    for (const [index, content] of contents.entries()) {
      await fixtures.db.insert(pageHistoryTable).values({
        pageId,
        siteId: fixtures.siteId,
        authorId: fixtures.userId,
        action: index === 0 ? 'created' : 'updated',
        via: via?.[index] ?? 'editor',
        locale: 'en',
        path: `revision-test/${pageId}`,
        title: 'Revision test page',
        content,
        versionDate: new Date(base + index * 60_000)
      })
    }
    return pageId
  }

  test('a page with five history rows reports ordinal 5', async () => {
    const pageId = await seedHistory(['a', 'a\nb', 'a\nb\nc', 'a\nb\nc\nd', 'a\nb\nc\nd\ne'])
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.equal(summary.ordinal, 5)
  })

  test('a page with no history reports ordinal 1, no change count, and via editor', async () => {
    const summary = await pageHistoryModel.revisionSummary(crypto.randomUUID())
    assert.equal(summary.ordinal, 1)
    // -> Absent, not zero: `rev 1` renders alone, and `· 0 changes` must never be reachable
    assert.equal('changeCount' in summary, false)
    // -> No row to answer from: falls back to the column's own default rather than being undefined
    assert.equal(summary.via, 'editor')
  })

  test('a page whose only version is its creation reports ordinal 1 and no change count', async () => {
    const pageId = await seedHistory(['# Just created\n'])
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 1, via: 'editor' })
  })

  test('the change count is added plus removed lines between the two newest versions', async () => {
    /*
      one → two: `beta` becomes `BETA` (1 removed + 1 added) and `delta` is appended (1 added), so a
      unified diff of the pair shows three changed lines. `zero` is two versions back and must not be
      part of the answer -- it is there to prove the diff is newest-vs-predecessor, not
      newest-vs-oldest.
    */
    const zero = 'nothing like the others\n'
    const one = 'alpha\nbeta\ngamma\n'
    const two = 'alpha\nBETA\ngamma\ndelta\n'
    const pageId = await seedHistory([zero, one, two])
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 3, changeCount: 3, via: 'editor' })
  })

  test('an unchanged save reports a real zero, distinct from an absent count', async () => {
    const pageId = await seedHistory(['same\n', 'same\n'])
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 2, changeCount: 0, via: 'editor' })
  })

  test('a null-source version counts as no lines rather than throwing', async () => {
    const pageId = await seedHistory(['one\ntwo\n', null])
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 2, changeCount: 2, via: 'editor' })
  })

  test('the newest row is mcp reports via mcp, regardless of earlier rows', async () => {
    const pageId = await seedHistory(['alpha\n', 'alpha\nbeta\n'], { via: ['editor', 'mcp'] })
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 2, changeCount: 1, via: 'mcp' })
  })

  test('the newest row is editor reports via editor, even when an earlier row was mcp', async () => {
    const pageId = await seedHistory(['alpha\n', 'alpha\nbeta\n'], { via: ['mcp', 'editor'] })
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.deepEqual(summary, { ordinal: 2, changeCount: 1, via: 'editor' })
  })

  test('versions written in the same millisecond still resolve to one newest pair', async () => {
    // -> The `(versionDate DESC, id DESC)` tie-break: whichever id wins, the count is over the same
    //    two rows and the answer is one of the two orderings, never an error or a missing row.
    const pageId = crypto.randomUUID()
    const versionDate = new Date(Date.UTC(2026, 0, 2, 9, 30, 0))
    for (const content of ['first\n', 'first\nsecond\n']) {
      await fixtures.db.insert(pageHistoryTable).values({
        pageId,
        siteId: fixtures.siteId,
        authorId: fixtures.userId,
        action: 'updated',
        locale: 'en',
        path: `revision-test/${pageId}`,
        title: 'Revision test page',
        content,
        versionDate
      })
    }
    const summary = await pageHistoryModel.revisionSummary(pageId)
    assert.equal(summary.ordinal, 2)
    assert.equal(summary.changeCount, 1)
  })
})
