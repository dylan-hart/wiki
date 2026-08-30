import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../../test/db.ts'
import { groups as groupsTable } from '../../../db/schema.ts'
import type { PageActor, PageInput } from '../../../models/pages.ts'
import type { GroupRule } from '../../../models/groups.ts'

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
  let groupsModel: typeof import('../../../models/groups.ts').groups
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('../../../models/pages.ts'))
    ;({ search: searchModel } = await import('../../../models/search.ts'))
    ;({ groups: groupsModel } = await import('../../../models/groups.ts'))
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

  /**
   * OpenProject #830 (upstream #2914, "Search Only Searches The Name of Pages"): `indexPage()`/
   * `rebuild()` weight `searchContent` into `p.ts` at weight `C`, below title (`A`) and description
   * (`B`), but they weight it IN -- so a term present only in the body, nowhere in the title or
   * description, must still be found. This is the acceptance test for that: the query term below
   * ("wallaby") appears only in the page body, not in its title or its (absent) description.
   */
  test('a created page is findable by body content that appears in neither its title nor its description', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/marsupials',
        title: 'Field Guide',
        content:
          '# Field Guide\n\nThis chapter describes the wallaby, a marsupial native to Australia.',
        // -> `searchContent` is derived from `render` (the editor's HTML), not from `content` (its
        //    markdown source) -- see `models/pages.ts#createPage`'s `postProcess()` call. A real
        //    editor always sends both together, so this is what a genuine save looks like.
        render:
          '<h1>Field Guide</h1><p>This chapter describes the wallaby, a marsupial native to Australia.</p>'
      }),
      actor
    )

    const result = await searchModel.query({ siteId: fixtures.siteId, query: 'wallaby' })

    assert.equal(result.totalHits, 1)
    assert.equal(result.results[0]!.path, 'docs/marsupials')
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
      engines: { db: { termHighlighting: true } },
      config: { dictOverrides: {} }
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

  /**
   * `movePage` can re-home a page into another locale, and which dictionary builds a page's `ts` is
   * decided by that locale — so a page moved from `en` to `fr` has to be re-indexed, or it stays
   * stemmed by the wrong language and quietly stops matching the way its neighbours in `fr` do. This
   * is what the `previousLocale` argument on `renamed()` exists for, and the assertion is against the
   * vector itself rather than a query, since a wrong stemmer degrades matching rather than breaking it.
   */
  test('a page moved into another locale is re-indexed with that locale dictionary', async () => {
    // -> `les`/`des` are french stopwords and english ordinary words, so the two dictionaries produce
    //    visibly different vectors for this content
    const content = 'Les documents des utilisateurs'
    const title = 'Les documents'
    const moved = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-move', locale: 'en', title, content, render: content }),
      actor
    )
    // -> The same content already living in `fr`: whatever this one's vector is, the moved page's has
    //    to end up identical, since neither path nor locale is weighted into `ts`
    const reference = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-reference', locale: 'fr', title, content, render: content }),
      actor
    )

    const vectorOf = async (id: string): Promise<string> => {
      const rows = await fixtures.db.execute(sql`SELECT ts::text AS ts FROM pages WHERE id = ${id}`)
      return ((rows as any).rows ?? rows)[0].ts
    }

    assert.notEqual(await vectorOf(moved.id), await vectorOf(reference.id))

    await pagesModel.movePage(
      fixtures.siteId,
      moved.id,
      { path: 'docs/locale-move', locale: 'fr' },
      actor
    )

    assert.equal(await vectorOf(moved.id), await vectorOf(reference.id))
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
   * OpenProject #830 (upstream #6541, permission-filtered instant-search suggestions): the endpoint
   * behind the header's live preview (`GET /sites/:siteId/pages/search`) is this same `query()` --
   * `api/pages.ts` passes it the requester's `accessActor` and nothing else narrows the result set for
   * an anonymous or under-privileged caller. So a match this actor has no `read:pages` access to must
   * never come back in `results`, not merely be excluded from the `suggestion` -- the "did you mean"
   * suggestion test below covers the latter already; this covers the former, which is what a reader
   * would actually see fill the instant-search dropdown.
   */
  test('query() never returns a page the actor has no read:pages access to', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/numbat', title: 'Numbat Habits' }),
      actor
    )
    /** No groups and no `manage:system` -- `groups.checkAccess()` denies every page permission. */
    const blockedActor: PageActor = { id: fixtures.userId, groupIds: [], permissions: [] }

    const asBlocked = await searchModel.query({
      siteId: fixtures.siteId,
      query: 'numbat',
      actor: blockedActor
    })
    assert.equal(asBlocked.totalHits, 0)
    assert.deepEqual(asBlocked.results, [])

    // -> Sanity check: the same query against the same page finds it once access is not blocked
    const unfiltered = await searchModel.query({ siteId: fixtures.siteId, query: 'numbat' })
    assert.equal(unfiltered.totalHits, 1)
  })

  /**
   * OpenProject #2151: `totalHits` used to be derived from the SQL window count corrected only for
   * rows dropped from the CURRENT page, so a match on a page the actor could not read still
   * inflated the total even when it never appeared in `results` — a count oracle. `limit=1` against
   * a corpus with two matches, one denied, is the audit's own repro: before the fix this reported
   * `totalHits: 1` (the correction only ever subtracted what was dropped from the single fetched
   * row, so a distinct denied match elsewhere in the result set was still counted). `totalHits` must
   * now never exceed the number of matches the actor can actually read, at every `limit`.
   */
  test('totalHits never exceeds the number of readable matches, including at limit=1 (OpenProject #2151)', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/wallaroo-public',
        title: 'Wallaroo Public Notes',
        content: '# Wallaroo\n\nEveryone may read this one.'
      }),
      actor
    )
    const secretPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/wallaroo-secret',
        title: 'Wallaroo Secret Notes',
        content: '# Wallaroo\n\nNobody but an admin may read this one.'
      }),
      actor
    )

    const rules: GroupRule[] = [
      {
        id: 'allow-all',
        name: 'Allow all',
        roles: ['read:pages'],
        match: 'START',
        mode: 'ALLOW',
        path: '',
        locales: [],
        sites: []
      },
      {
        id: 'deny-secret',
        name: 'Deny secret',
        roles: ['read:pages'],
        match: 'EXACT',
        mode: 'DENY',
        path: secretPage.path,
        locales: [],
        sites: []
      }
    ]
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    /** Denies `read:pages` on exactly the secret page, and allows everything else. */
    const restrictedActor: PageActor = {
      id: fixtures.userId,
      groupIds: [fixtures.groupId],
      permissions: []
    }

    // -> Sanity check: the restricted actor really can read one and not the other
    assert.equal(
      groupsModel.checkAccess(restrictedActor as any, 'read:pages', {
        path: 'docs/wallaroo-public',
        locale: 'en',
        siteId: fixtures.siteId,
        classification: null
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(restrictedActor as any, 'read:pages', {
        path: secretPage.path,
        locale: 'en',
        siteId: fixtures.siteId,
        classification: null
      }),
      false
    )

    for (const limit of [1, 10]) {
      const result = await searchModel.query({
        siteId: fixtures.siteId,
        query: 'wallaroo',
        actor: restrictedActor,
        limit
      })
      assert.equal(result.totalHits, 1, `expected exactly 1 readable match at limit=${limit}`)
      assert.ok(
        result.results.every((r) => r.path !== secretPage.path),
        'the denied page must never appear in results, at any limit'
      )
    }
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

describe('db search module query() siteId threading (task 678)', () => {
  /**
   * Regression test for task 678: `query()`'s actor-scoped results filter runs each row through
   * `WIKI.models.groups.checkAccess`, but the inline page ref it built never carried `siteId` — so a
   * rule scoped to one site (task 671) could not distinguish this site's results from another's.
   * `siteId` is already in `query()`'s enclosing scope; this only proves it reaches the
   * `checkAccess` call made over the filtered rows. Mock-based rather than DB-backed, since this is
   * a pure wiring check — `models/search.ts`'s original `searchPages()` carried an equivalent test
   * before task #561 moved the implementation here (see the module doc comment above); this replaces
   * it at the new location rather than leaving it pointed at code that no longer exists.
   */

  let checkAccessCalls: any[] = []

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: {},
      sites: {},
      db: {
        execute: async () => ({
          rows: [
            {
              id: 'page-1',
              path: 'engineering/onboarding',
              locale: 'en',
              title: 'Onboarding',
              description: null,
              icon: null,
              tags: ['guide'],
              updatedAt: '2026-01-01T00:00:00.000Z',
              relevancy: 0,
              highlight: null,
              totalHits: 1
            }
          ]
        })
      },
      models: {
        groups: {
          checkAccess: (actor: any, permission: string, page: any) => {
            checkAccessCalls.push(page)
            return true
          }
        }
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('query: threads siteId into the RulePageRef passed to checkAccess', async () => {
    checkAccessCalls = []
    const { default: dbSearchModule } = await import('./search.ts')

    await dbSearchModule.query({
      siteId: '11111111-1111-4111-8111-111111111111',
      actor: { groupIds: [], permissions: [] } as any
    })

    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
  })
})
