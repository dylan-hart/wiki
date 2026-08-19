import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../../test/db.ts'
import type { PageActor, PageInput } from '../../../models/pages.ts'

/**
 * Task #561 moved every bit of postgres full-text logic (`dictionaryForLocale`, `searchPages` ->
 * `query`, `rebuildIndex` -> `rebuild`, `indexPage` -> the `created`/`updated` hooks, and the
 * `ts_headline`/`ts_filter`/`totalHits` SQL underneath all of it) out of `models/search.ts` and into
 * this module, verbatim. `models/search.test.ts` covers the dispatcher's resolution/delegation with a
 * fake engine; this suite is the one that actually runs the moved SQL, so a mistake made while moving
 * it — a dropped condition, a flipped weight, a broken `totalHits` count — fails a real query against
 * a real database rather than only failing to typecheck.
 *
 * `created`/`updated` write to `pages.ts` through `try/catch` and only ever log a failure (see the
 * doc comment on `indexPage` in `search.ts`), so a broken query in there would not throw and would
 * not fail `models/pages.test.ts` either — searching for the content after the fact, as this suite
 * does, is what actually exercises it.
 */
describe('db search module (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('../../../models/pages.ts').pages
  let searchModel: typeof import('../../../models/search.ts').search
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('../../../models/pages.ts'))
    ;({ search: searchModel } = await import('../../../models/search.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
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

  test('a created page is findable by its title through the dispatcher', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/kangaroo', title: 'The Wandering Kangaroo' }),
      actor
    )

    const result = await searchModel.query({ siteId: fixtures.siteId, query: 'kangaroo' })

    assert.equal(result.totalHits, 1)
    assert.equal(result.results[0]!.path, 'docs/kangaroo')
    assert.equal(result.results[0]!.title, 'The Wandering Kangaroo')
  })

  test('a page edited to a new title becomes findable by it, and stops matching the old one', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/retitle-me', title: 'Original Platypus Title' }),
      actor
    )
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Echidna Edition' }, actor)

    const byOldTitle = await searchModel.query({ siteId: fixtures.siteId, query: 'platypus' })
    const byNewTitle = await searchModel.query({ siteId: fixtures.siteId, query: 'echidna' })

    assert.equal(byOldTitle.totalHits, 0)
    assert.equal(byNewTitle.totalHits, 1)
    assert.equal(byNewTitle.results[0]!.path, 'docs/retitle-me')
  })

  test('a password-protected page matches on title but withholds its highlight', async () => {
    WIKI.sites[fixtures.siteId]!.config.search = {
      engine: 'db',
      config: { termHighlighting: true, dictOverrides: {} }
    }
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/vault',
        title: 'Vault Wombat Secrets',
        content: '# Vault Wombat Secrets\n\nOnly the body mentions marsupial biscuits.',
        password: 'letmein'
      }),
      actor
    )

    // -> Matches on the title, which the password does not cover
    const byTitle = await searchModel.query({ siteId: fixtures.siteId, query: 'wombat' })
    assert.equal(byTitle.totalHits, 1)
    assert.equal(byTitle.results[0]!.highlight, null)

    // -> The password-covered body never surfaces the page at all, per `hideProtectedContent`
    const byBody = await searchModel.query({ siteId: fixtures.siteId, query: 'biscuits' })
    assert.equal(byBody.totalHits, 0)
  })

  test('rebuild recomputes the index for a site and existing matches keep matching', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/quokka', title: 'Quokka Field Notes' }),
      actor
    )

    const result = await searchModel.rebuild(fixtures.siteId)

    assert.ok(result.pages >= 1)
    assert.ok(result.locales.some((l) => l.locale === 'en' && l.dictionary === 'english'))

    const found = await searchModel.query({ siteId: fixtures.siteId, query: 'quokka' })
    assert.equal(found.totalHits, 1)
  })

  test('a deleted page no longer matches', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/bandicoot', title: 'Bandicoot Census' }),
      actor
    )
    assert.equal(
      (await searchModel.query({ siteId: fixtures.siteId, query: 'bandicoot' })).totalHits,
      1
    )

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)

    assert.equal(
      (await searchModel.query({ siteId: fixtures.siteId, query: 'bandicoot' })).totalHits,
      0
    )
  })

  /**
   * `suggestTitle()` (`pg_trgm` similarity) is private on this module and reachable only through
   * `query()`'s own `suggestion` field — see the doc comment on `suggestTitle` for why a "did you
   * mean" is capped to the same visibility rules as the search itself.
   */
  describe('"did you mean" suggestions', () => {
    let readerActor: PageActor
    let blockedActor: PageActor

    before(async () => {
      /** `manage:system` short-circuits `groups.checkAccess()`, which is all a read-access actor needs here. */
      readerActor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      /** No groups and no `manage:system` — `checkAccess()` denies every page permission for this actor. */
      blockedActor = { id: fixtures.userId, groupIds: [], permissions: [] }

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/onboarding-guide', title: 'Onboarding Guide' }),
        actor
      )
    })

    test('query sets `suggestion` only when the query found nothing', async () => {
      const noHits = await searchModel.query({
        siteId: fixtures.siteId,
        query: 'Onboardign Gude',
        actor: readerActor
      })
      assert.equal(noHits.totalHits, 0)
      assert.equal(noHits.suggestion, 'Onboarding Guide')

      const hits = await searchModel.query({
        siteId: fixtures.siteId,
        query: 'Onboarding',
        actor: readerActor
      })
      assert.ok(hits.totalHits > 0)
      assert.equal(hits.suggestion, null)

      const noQuery = await searchModel.query({ siteId: fixtures.siteId, actor: readerActor })
      assert.equal(noQuery.suggestion, null)
    })

    test('the suggestion stays below the similarity threshold for an unrelated query', async () => {
      const result = await searchModel.query({
        siteId: fixtures.siteId,
        query: 'completely unrelated topic',
        actor: readerActor
      })
      assert.equal(result.suggestion, null)
    })

    test('the suggestion never names a page the actor cannot read', async () => {
      const result = await searchModel.query({
        siteId: fixtures.siteId,
        query: 'Onboardign Gude',
        // -> No groups and no `manage:system`, so the group rule engine denies every path
        actor: blockedActor
      })
      assert.equal(result.totalHits, 0)
      assert.equal(result.suggestion, null)
    })
  })
})
