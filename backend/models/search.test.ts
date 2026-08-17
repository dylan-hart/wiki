import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { PageActor } from './pages.ts'
import type { AccessActor } from './groups.ts'

/** `manage:system` short-circuits `groups.checkAccess()`, which is all a read-access actor needs here. */
const readerActor: AccessActor = { groupIds: [], permissions: ['manage:system'] }
/** No groups and no `manage:system` — `checkAccess()` denies every page permission for this actor. */
const blockedActor: AccessActor = { groupIds: [], permissions: [] }

/**
 * `search.suggestTitle()` (and its wiring into `searchPages()`'s `suggestion` field) is a
 * `pg_trgm` similarity query, so — like `models/pages.ts`'s suite — this runs against a real,
 * migrated database rather than mocking the query builder.
 */
describe('search "did you mean" suggestions (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let searchModel: typeof import('./search.ts').search
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ search: searchModel } = await import('./search.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'] }

    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'docs/onboarding-guide',
        title: 'Onboarding Guide',
        editor: 'markdown',
        content: 'Steps for a new hire.'
      },
      actor
    )
  })

  after(async () => {
    await teardownTestDb()
  })

  test('suggestTitle finds a close title for a misspelled query', async () => {
    const suggestion = await searchModel.suggestTitle({
      siteId: fixtures.siteId,
      query: 'Onboardign Gude',
      actor: readerActor
    })

    assert.equal(suggestion, 'Onboarding Guide')
  })

  test('suggestTitle returns null below the similarity threshold', async () => {
    const suggestion = await searchModel.suggestTitle({
      siteId: fixtures.siteId,
      query: 'completely unrelated topic',
      actor: readerActor
    })

    assert.equal(suggestion, null)
  })

  test('suggestTitle returns null for an empty query', async () => {
    const suggestion = await searchModel.suggestTitle({
      siteId: fixtures.siteId,
      query: '   ',
      actor: readerActor
    })

    assert.equal(suggestion, null)
  })

  test('searchPages sets `suggestion` only when the query found nothing', async () => {
    const noHits = await searchModel.searchPages({
      siteId: fixtures.siteId,
      query: 'Onboardign Gude',
      actor: readerActor
    })
    assert.equal(noHits.totalHits, 0)
    assert.equal(noHits.suggestion, 'Onboarding Guide')

    const hits = await searchModel.searchPages({
      siteId: fixtures.siteId,
      query: 'Onboarding',
      actor: readerActor
    })
    assert.ok(hits.totalHits > 0)
    assert.equal(hits.suggestion, null)

    const noQuery = await searchModel.searchPages({
      siteId: fixtures.siteId,
      actor: readerActor
    })
    assert.equal(noQuery.suggestion, null)
  })

  test('suggestTitle never names a page the actor cannot read', async () => {
    const suggestion = await searchModel.suggestTitle({
      siteId: fixtures.siteId,
      query: 'Onboardign Gude',
      // -> No groups and no `manage:system`, so the group rule engine denies every path
      actor: blockedActor
    })

    assert.equal(suggestion, null)
  })
})
