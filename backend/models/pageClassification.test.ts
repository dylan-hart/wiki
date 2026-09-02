import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * The floor invariant and the classification reports, exercised through real `createPage`/
 * `updatePage`/`movePage` writes against a real parent/child hierarchy —
 * `models/classificationLevels.test.ts` only covers the pure `meetsFloor`/`stricterOf` math, and
 * `api/pages.classification.test.ts` stubs the model entirely, so this is what proves
 * `resolveCreateClassification`'s parent lookup and `moveOnePageInTx`'s auto-bump actually run
 * against real rows.
 */
describe('pageClassification (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let pageClassificationModel: typeof import('./pageClassification.ts').pageClassification
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ pageClassification: pageClassificationModel } = await import('./pageClassification.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    // -> Puppeteer is never installed in this test environment, so a real `ensureCanRender()` would
    //    refuse every renderless create/update below (OpenProject #1716).
    mock.method(WIKI.models.renderQueue, 'ensureCanRender', async () => {})
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  /**
   * OpenProject #1702: a bare `UPDATE` here left external search modules indexing the pre-raise
   * classification (they decide `read:pages` visibility per-hit off the indexed copy — see
   * `modules/search/algolia/search.ts`), and left `glossary.ts#getRawCachedTerms`'s cached
   * `pageClassification` stale for any term canonically linked to one of these pages. This asserts
   * both post-write effects: one `search.updated` call per id in the batch, and exactly one
   * `glossary.invalidateCache` for the site, not one per page.
   */
  test('bulkSetClassification calls search.updated per page and invalidates the glossary cache once for the whole batch', async () => {
    const { classificationLevels } = await import('./classificationLevels.ts')
    const restrictedId = classificationLevels.list().find((l) => l.name === 'Restricted')!.id

    const updatedIds: string[] = []
    let invalidateCalls = 0
    const searchModel = (globalThis as any).WIKI.models.search
    const glossaryModel = (globalThis as any).WIKI.models.glossary
    searchModel.updated = async (page: any) => {
      updatedIds.push(page.id)
    }
    const originalInvalidateCache = glossaryModel.invalidateCache
    glossaryModel.invalidateCache = (siteId: string) => {
      assert.equal(siteId, fixtures.siteId)
      invalidateCalls++
    }

    try {
      const pageA = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/bulk-classify-one' }),
        actor
      )
      const pageB = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/bulk-classify-two', title: 'Two' }),
        actor
      )

      const updatedCount = await pageClassificationModel.bulkSetClassification(
        fixtures.siteId,
        [pageA.id, pageB.id],
        restrictedId
      )

      assert.equal(updatedCount, 2)
      assert.deepEqual(new Set(updatedIds), new Set([pageA.id, pageB.id]))
      assert.equal(invalidateCalls, 1)

      const fetchedA = await pagesModel.getPage({ siteId: fixtures.siteId, id: pageA.id })
      const fetchedB = await pagesModel.getPage({ siteId: fixtures.siteId, id: pageB.id })
      assert.equal(fetchedA!.classification, restrictedId)
      assert.equal(fetchedB!.classification, restrictedId)
    } finally {
      delete searchModel.updated
      glossaryModel.invalidateCache = originalInvalidateCache
    }
  })

  test('bulkSetClassification calls neither the search dispatcher nor the glossary cache for an empty id list', async () => {
    let searchCalls = 0
    let invalidateCalls = 0
    const searchModel = (globalThis as any).WIKI.models.search
    const glossaryModel = (globalThis as any).WIKI.models.glossary
    searchModel.updated = async () => {
      searchCalls++
    }
    const originalInvalidateCache = glossaryModel.invalidateCache
    glossaryModel.invalidateCache = () => {
      invalidateCalls++
    }

    try {
      const updatedCount = await pageClassificationModel.bulkSetClassification(
        fixtures.siteId,
        [],
        fixtures.classificationId
      )
      assert.equal(updatedCount, 0)
      assert.equal(searchCalls, 0)
      assert.equal(invalidateCalls, 0)
    } finally {
      delete searchModel.updated
      glossaryModel.invalidateCache = originalInvalidateCache
    }
  })

  /**
   * OpenProject #1080: the floor invariant itself, exercised through `createPage`/`updatePage`/
   * `movePage` against a real parent/child hierarchy -- `models/classificationLevels.test.ts` only
   * covers the pure `meetsFloor`/`stricterOf` math, and `api/pages.classification.test.ts` stubs the
   * model entirely, so nothing else proves `resolveCreateClassification`'s parent lookup or
   * `moveOnePageInTx`'s auto-bump actually run against real rows.
   */
  describe('classification floor invariant (OpenProject #1080)', () => {
    let internalId: string
    let restrictedId: string

    before(async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      internalId = levels.find((l) => l.name === 'Internal')!.id
      restrictedId = levels.find((l) => l.name === 'Restricted')!.id
    })

    test('a root-level page with no explicit classification defaults to the most-open level', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/root-default' }),
        actor
      )
      assert.equal(page.classification, fixtures.classificationId)
    })

    test('a child page with no explicit classification inherits its immediate parent', async () => {
      const parent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/inherit-parent', classification: restrictedId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: `${parent.path}/child` }),
        actor
      )
      assert.equal(child.classification, restrictedId)
    })

    test('an explicit classification more open than the parent is rejected', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/reject-parent', classification: restrictedId }),
        actor
      )
      await assert.rejects(
        pagesModel.createPage(
          fixtures.siteId,
          pageInput({
            path: 'floor/reject-parent/child',
            classification: fixtures.classificationId
          }),
          actor
        ),
        /classificationBelowFloor/
      )
    })

    test('an explicit classification at or above the parent floor succeeds', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/accept-parent', classification: internalId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/accept-parent/child', classification: restrictedId }),
        actor
      )
      assert.equal(child.classification, restrictedId)
    })

    test('updatePage rejects lowering below the immediate parent floor', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/update-parent', classification: restrictedId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/update-parent/child', classification: restrictedId }),
        actor
      )
      await assert.rejects(
        pagesModel.updatePage(
          fixtures.siteId,
          child.id,
          { classification: fixtures.classificationId },
          actor
        ),
        /classificationBelowFloor/
      )
    })

    test('movePage auto-bumps a page onto a new, stricter parent floor', async () => {
      const strictParent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/move-strict-parent', classification: restrictedId }),
        actor
      )
      const openPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'floor/move-open-page',
          classification: fixtures.classificationId
        }),
        actor
      )
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        openPage.id,
        { path: `${strictParent.path}/moved-in` },
        actor
      )
      assert.equal(moved!.classification, restrictedId)
    })

    /**
     * OpenProject #1935: `page:classification-changed` must fire on a real level change and stay
     * silent on a patch that merely restates the current level -- the editor sends every field on
     * every save, so `patch.classification !== undefined` alone is not the right guard. Spies on
     * `WIKI.models.hooks.emit` the same way this file already spies on `WIKI.models.search` above
     * (own-property shadow, restored via `delete` in `finally`).
     */
    test('updatePage emits page:classification-changed only when the level actually changes', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/hook-classification', classification: internalId }),
        actor
      )

      const hooksModel = (globalThis as any).WIKI.models.hooks
      const emitted: { event: string; siteId: string | null; data: any }[] = []
      hooksModel.emit = async (event: string, siteId: string | null, data: any) => {
        emitted.push({ event, siteId, data })
        return 0
      }

      try {
        // -> Restates the current level: must fire nothing
        await pagesModel.updatePage(fixtures.siteId, page.id, { classification: internalId }, actor)
        assert.equal(
          emitted.filter((e) => e.event === 'page:classification-changed').length,
          0,
          'a no-op classification restate must not emit page:classification-changed'
        )

        // -> An actual change: must fire exactly once, carrying the old and new level
        await pagesModel.updatePage(
          fixtures.siteId,
          page.id,
          { classification: restrictedId },
          actor
        )
        const changeEvents = emitted.filter((e) => e.event === 'page:classification-changed')
        assert.equal(changeEvents.length, 1, 'a real classification change must emit exactly once')
        const [{ siteId, data }] = changeEvents
        assert.equal(siteId, fixtures.siteId)
        assert.equal(data.id, page.id)
        assert.equal(data.path, page.path)
        assert.equal(data.siteId, fixtures.siteId)
        assert.equal(data.previousClassification, internalId)
        assert.equal(data.classification, restrictedId)
      } finally {
        delete hooksModel.emit
      }
    })

    test('movePage never lowers a page already at or above the new floor', async () => {
      const openParent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'floor/move-open-parent',
          classification: fixtures.classificationId
        }),
        actor
      )
      const strictPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/move-strict-page', classification: restrictedId }),
        actor
      )
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        strictPage.id,
        { path: `${openParent.path}/moved-in` },
        actor
      )
      assert.equal(moved!.classification, restrictedId)
    })
  })

  /**
   * OpenProject #1081: "everything currently classified as X" -- `classificationReport()`'s per-level
   * counts and `listByClassification()`'s drill-down, both instance-wide by default and narrowable to
   * one site.
   */
  describe('classificationReport / listByClassification (OpenProject #1081)', () => {
    test('every configured level is included, even at zero, in level order', async () => {
      const report = await pageClassificationModel.classificationReport()
      assert.equal(report.length, 3)
      assert.deepEqual(
        report.map((r) => r.sortOrder),
        [0, 1, 2]
      )
      assert.ok(report.every((r) => typeof r.count === 'number'))
    })

    test('counts and drill-down entries reflect what was actually created', async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      const restricted = levels[levels.length - 1]!

      const before = await pageClassificationModel.classificationReport(fixtures.siteId)
      const beforeCount = before.find((r) => r.levelId === restricted.id)!.count

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classification-report/one', classification: restricted.id }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classification-report/two', classification: restricted.id }),
        actor
      )

      const after = await pageClassificationModel.classificationReport(fixtures.siteId)
      assert.equal(after.find((r) => r.levelId === restricted.id)!.count, beforeCount + 2)

      const drillDown = await pageClassificationModel.listByClassification(restricted.id, {
        siteId: fixtures.siteId
      })
      assert.equal(drillDown.total, beforeCount + 2)
      const paths = drillDown.entries.map((e) => e.path)
      assert.ok(paths.includes('classification-report/one'))
      assert.ok(paths.includes('classification-report/two'))
    })

    test('listByClassification paginates with limit/offset', async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const publicLevel = classificationLevels.defaultLevel()

      for (let i = 0; i < 3; i++) {
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({ path: `classification-page/${i}`, classification: publicLevel.id }),
          actor
        )
      }

      const firstPage = await pageClassificationModel.listByClassification(publicLevel.id, {
        siteId: fixtures.siteId,
        limit: 2,
        offset: 0
      })
      assert.equal(firstPage.entries.length, 2)
      assert.ok(firstPage.total >= 3)
    })
  })
})
