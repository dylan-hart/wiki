import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../../test/db.ts'
import { groups as groupsTable } from '../../../db/schema.ts'
import { installTestWiki } from '../../../test/mocks.ts'
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
      return (rows as any).rows[0].ts
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
   * `api/pages/read.ts` passes it the requester's `accessActor` and nothing else narrows the result set for
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
    // -> The window function counted the row postgres matched; the rules filter then dropped it from
    //    this page, so the corrected total is no longer exact -- see OpenProject #2006.
    assert.equal(asBlocked.totalHitsApproximate, true)

    // -> Sanity check: the same query against the same page finds it once access is not blocked
    const unfiltered = await searchModel.query({ siteId: fixtures.siteId, query: 'numbat' })
    assert.equal(unfiltered.totalHits, 1)
    // -> Nothing was dropped by the rules filter here (no `actor` was even passed), so the total is exact
    assert.equal(unfiltered.totalHitsApproximate, false)
  })

  /**
   * OpenProject #2151: `totalHits` used to be `COUNT(*) OVER()` over the *unfiltered* text query,
   * adjusted only by what `checkAccess` dropped from the single page already fetched — so a match
   * outside that page, which the actor could never actually read, still inflated the count. This is
   * most visible at `limit: 1`: three pages share the term below, but the actor may read only one of
   * them, so `visible` (what `checkAccess` actually lets them see) is the true readable-matches
   * count. The old arithmetic reported 2 or 3 there (`windowCount(3) - rows.length(1) +
   * visible.length(0 or 1)`, depending only on which single row postgres's LIMIT happened to return)
   * — always more than the one page this actor may see.
   */
  test('totalHits never exceeds what the actor may actually read, even at limit: 1', async () => {
    const readablePath = 'docs/bilby-public'
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: readablePath, title: 'Bilby Public Notes' }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/bilby-secret-a', title: 'Bilby Secret Notes A' }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/bilby-secret-b', title: 'Bilby Secret Notes B' }),
      actor
    )

    // -> A group whose only rule grants `read:pages` on exactly `readablePath` — nothing grants it
    //    on the other two, and nothing is granted by default (see `helpers/pageRules.ts`), so a
    //    guest-like actor in only this group can read that one page and none of the others.
    const [restrictedGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Bilby Readers',
        permissions: [],
        rules: [
          {
            id: randomUUID(),
            name: 'Allow the public bilby page',
            roles: ['read:pages'],
            match: 'EXACT',
            mode: 'ALLOW',
            path: readablePath,
            locales: [],
            sites: []
          }
        ]
      })
      .returning({ id: groupsTable.id })
    await WIKI.models.groups.reloadCache()

    const restrictedActor: PageActor = {
      id: fixtures.userId,
      groupIds: [restrictedGroup!.id],
      permissions: []
    }

    const atLimitOne = await searchModel.query({
      siteId: fixtures.siteId,
      query: 'bilby',
      actor: restrictedActor,
      limit: 1
    })
    assert.equal(atLimitOne.totalHits, 1)
    assert.equal(atLimitOne.results.length, 1)
    assert.equal(atLimitOne.results[0]!.path, readablePath)

    // -> Same actor, no `limit` narrowing the page fetched — the count must still reflect only the
    //    one page they may read, not all three matches.
    const unpaged = await searchModel.query({
      siteId: fixtures.siteId,
      query: 'bilby',
      actor: restrictedActor
    })
    assert.equal(unpaged.totalHits, 1)
    assert.deepEqual(
      unpaged.results.map((r) => r.path),
      [readablePath]
    )

    // -> Sanity check: the unrestricted actor sees all three
    const unrestricted = await searchModel.query({ siteId: fixtures.siteId, query: 'bilby' })
    assert.equal(unrestricted.totalHits, 3)
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

  /**
   * OpenProject #2010: `query()` used to run a single `LIMIT`/`OFFSET` window against raw rows and
   * filter denied ones out afterward — so a page could come back smaller than `limit` even though a
   * later raw row (already earmarked for the NEXT page) would have filled it. For a reader whose page
   * rules deny only part of a matching set, that meant every page shrank and the true boundary between
   * "seen" and "not yet seen" results drifted from what a plain `offset += limit` walk assumed. The
   * fix over-fetches a candidate window from the top of the (deterministic) result order, filters it,
   * and slices the requested page out of the filtered array — this is what proves that: walking
   * `offset` forward in `limit`-sized steps for a restricted reader returns full pages (until matches
   * run out), with no result repeated and none skipped.
   */
  describe('paging stability for a restricted reader', () => {
    let readerActor: PageActor

    before(async () => {
      const rules: GroupRule[] = [
        {
          id: randomUUID(),
          name: 'allow everything by default',
          roles: ['read:pages'],
          match: 'START',
          mode: 'ALLOW',
          path: '',
          locales: [],
          sites: []
        },
        {
          id: randomUUID(),
          name: 'deny the hidden branch',
          roles: ['read:pages'],
          match: 'START',
          mode: 'DENY',
          path: 'docs/hidden',
          locales: [],
          sites: []
        }
      ]
      /*
        Written directly rather than through `groups.updateGroup()`: that method's guest-role
        clamping reads `WIKI.data.systemIds.guestsGroupId`, which the DB-backed test fixture's
        minimal `WIKI` (`test/db.ts`) never populates -- out of scope for this module's own suite to
        add. `reloadCache()` is the same in-memory refresh `updateGroup()` itself triggers, so
        `checkAccess()` sees these rules exactly as it would after a real admin edit.
      */
      await fixtures.db
        .update(groupsTable)
        .set({ rules })
        .where(eq(groupsTable.id, fixtures.groupId))
      const { groups: groupsModel } = await import('../../../models/groups.ts')
      await groupsModel.reloadCache()

      readerActor = { id: fixtures.userId, groupIds: [fixtures.groupId], permissions: [] }
    })

    test('pages stay full and non-overlapping across offsets when part of the match set is denied', async () => {
      // -> 12 pages sharing one tag, titled so alphabetical order is predictable; every third one
      //    (03, 06, 09, 12) lives under the denied branch. 8 of the 12 survive the reader's rules.
      for (let i = 1; i <= 12; i++) {
        const isHidden = i % 3 === 0
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({
            path: isHidden ? `docs/hidden/paging-${i}` : `docs/open/paging-${i}`,
            title: `Paging Stability ${String(i).padStart(2, '0')}`,
            tags: ['paging-stability-2010']
          }),
          actor
        )
      }

      const fetchPage = (pageOffset: number, pageLimit: number) =>
        searchModel.query({
          siteId: fixtures.siteId,
          tags: ['paging-stability-2010'],
          orderBy: 'title',
          orderByDirection: 'asc',
          offset: pageOffset,
          limit: pageLimit,
          actor: readerActor
        })

      const limit = 3
      const page1 = await fetchPage(0, limit)
      const page2 = await fetchPage(limit, limit)
      const page3 = await fetchPage(limit * 2, limit)

      // -> Full pages while visible matches remain (8 visible total: 3 + 3 + 2), never a page shrunk
      //    below `limit` just because a denied row happened to fall inside its raw window.
      assert.equal(page1.results.length, 3)
      assert.equal(page2.results.length, 3)
      assert.equal(page3.results.length, 2)

      const seenPaths = [...page1.results, ...page2.results, ...page3.results].map((r) => r.path)

      // -> No repeats
      assert.equal(new Set(seenPaths).size, seenPaths.length)
      // -> No hidden-branch page ever surfaces
      assert.ok(seenPaths.every((p) => !p.startsWith('docs/hidden/')))
      // -> Nothing skipped: exactly the 8 open-branch pages, none missing
      assert.deepEqual(
        seenPaths.sort(),
        Array.from({ length: 12 }, (_, idx) => idx + 1)
          .filter((i) => i % 3 !== 0)
          .map((i) => `docs/open/paging-${i}`)
          .sort()
      )
    })

    /**
     * Forces the over-fetch loop to grow past its initial margin: 32 denied rows sort before 4
     * visible ones (`H` < `V`), so the first candidate window (`limit + OVERFETCH_MARGIN` = well
     * under 32) comes back with zero surviving rows and has to be widened before the first page can
     * be filled at all.
     */
    test('the candidate window grows when the initial margin is not enough', async () => {
      for (let i = 1; i <= 32; i++) {
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({
            path: `docs/hidden/growth-h-${i}`,
            title: `H ${String(i).padStart(2, '0')}`,
            tags: ['paging-growth-2010']
          }),
          actor
        )
      }
      for (let i = 1; i <= 4; i++) {
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({
            path: `docs/open/growth-v-${i}`,
            title: `V ${String(i).padStart(2, '0')}`,
            tags: ['paging-growth-2010']
          }),
          actor
        )
      }

      const result = await searchModel.query({
        siteId: fixtures.siteId,
        tags: ['paging-growth-2010'],
        orderBy: 'title',
        orderByDirection: 'asc',
        offset: 0,
        limit: 3,
        actor: readerActor
      })

      assert.equal(result.results.length, 3)
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['docs/open/growth-v-1', 'docs/open/growth-v-2', 'docs/open/growth-v-3']
      )
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
  let wikiHandle: { restore(): void }

  before(async () => {
    wikiHandle = installTestWiki({
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
    })
  })

  after(() => {
    wikiHandle.restore()
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

describe('db search module query() totalHitsApproximate (OpenProject #2006)', () => {
  /**
   * Mock-based, same reasoning as the "siteId threading" suite above: whether `totalHitsApproximate`
   * is set is decided entirely by comparing the row count before and after the `checkAccess` filter,
   * with no SQL of its own to exercise against a real database -- so a fake two-row response plus a
   * controllable `checkAccess` is enough to cover both branches fast, leaving the "does this actually
   * happen against real page rules" case to the DB-backed suite above.
   */
  function rowFixtures() {
    return [
      {
        id: 'page-1',
        path: 'engineering/onboarding',
        locale: 'en',
        title: 'Onboarding',
        description: null,
        icon: null,
        tags: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
        relevancy: 0,
        highlight: null,
        totalHits: 2
      },
      {
        id: 'page-2',
        path: 'engineering/secret-roadmap',
        locale: 'en',
        title: 'Secret Roadmap',
        description: null,
        icon: null,
        tags: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
        relevancy: 0,
        highlight: null,
        totalHits: 2
      }
    ]
  }

  let wikiHandle: { restore(): void }

  function installWiki(checkAccess: (page: any) => boolean) {
    wikiHandle = installTestWiki({
      db: { execute: async () => ({ rows: rowFixtures() }) },
      models: {
        groups: { checkAccess: (_actor: any, _permission: string, page: any) => checkAccess(page) }
      }
    })
  }

  afterEach(() => {
    wikiHandle.restore()
  })

  test('is true when the rules filter drops a row the engine counted', async () => {
    installWiki((page) => page.path !== 'engineering/secret-roadmap')
    const { default: dbSearchModule } = await import('./search.ts')

    const result = await dbSearchModule.query({
      siteId: '11111111-1111-4111-8111-111111111111',
      actor: { groupIds: [], permissions: [] } as any
    })

    assert.equal(result.results.length, 1)
    assert.equal(result.totalHitsApproximate, true)
  })

  test('is false when the rules filter drops nothing', async () => {
    installWiki(() => true)
    const { default: dbSearchModule } = await import('./search.ts')

    const result = await dbSearchModule.query({
      siteId: '11111111-1111-4111-8111-111111111111',
      actor: { groupIds: [], permissions: [] } as any
    })

    assert.equal(result.results.length, 2)
    assert.equal(result.totalHitsApproximate, false)
  })

  test('is false when no actor is given to filter against', async () => {
    installWiki(() => {
      throw new Error('checkAccess should not be called without an actor')
    })
    const { default: dbSearchModule } = await import('./search.ts')

    const result = await dbSearchModule.query({
      siteId: '11111111-1111-4111-8111-111111111111'
    })

    assert.equal(result.results.length, 2)
    assert.equal(result.totalHitsApproximate, false)
  })
})
