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
 * `created`/`updated` index through a `try/catch` that only logs a failure, so a broken query there
 * throws nothing and fails no other suite — searching for the content afterwards, as this suite
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

  test('a created page is findable by body content that appears in neither its title nor its description', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/marsupials',
        title: 'Field Guide',
        content:
          '# Field Guide\n\nThis chapter describes the wallaby, a marsupial native to Australia.',
        // -> `searchContent` is derived from `render`, not from `content`, so a fixture that set
        //    only the markdown source would index nothing
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
    CARDINAL.sites[fixtures.siteId]!.config.search = {
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

    const byTitle = await searchModel.query({ siteId: fixtures.siteId, query: 'wombat' })
    assert.equal(byTitle.totalHits, 1)
    assert.equal(byTitle.results[0]!.highlight, null)

    // -> Terms only in the password-covered body never surface the page at all
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
   * Which dictionary builds a page's `ts` is decided by its locale, so a page moved from `en` to
   * `fr` has to be re-indexed or it stays stemmed by the wrong language. Asserted against the vector
   * itself rather than a query, since a wrong stemmer degrades matching rather than breaking it.
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
    // -> The oracle: the same content already living in `fr`. Neither path nor locale is weighted
    //    into `ts`, so the moved page's vector has to end up identical to this one's
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
   * The header's instant-search dropdown is this same `query()`, passed the requester's actor and
   * nothing else narrowing the result set — so a denied match must be absent from `results` itself,
   * not merely excluded from `suggestion`, which the "did you mean" tests below cover.
   */
  test('query() never returns a page the actor has no read:pages access to', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/numbat', title: 'Numbat Habits' }),
      actor
    )
    /** No groups and no `manage:system`: `checkAccess()` denies every page permission. */
    const blockedActor: PageActor = { id: fixtures.userId, groupIds: [], permissions: [] }

    const asBlocked = await searchModel.query({
      siteId: fixtures.siteId,
      query: 'numbat',
      actor: blockedActor
    })
    assert.equal(asBlocked.totalHits, 0)
    assert.deepEqual(asBlocked.results, [])
    // -> The rules filter dropped a row postgres matched, so the total is no longer exact
    assert.equal(asBlocked.totalHitsApproximate, true)

    const unfiltered = await searchModel.query({ siteId: fixtures.siteId, query: 'numbat' })
    assert.equal(unfiltered.totalHits, 1)
    // -> No actor to filter against, so nothing is dropped and the total is exact
    assert.equal(unfiltered.totalHitsApproximate, false)
  })

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

    // -> Nothing is granted by default, so this one ALLOW rule is the actor's entire read access
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
    await CARDINAL.models.groups.reloadCache()

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

    const unrestricted = await searchModel.query({ siteId: fixtures.siteId, query: 'bilby' })
    assert.equal(unrestricted.totalHits, 3)
  })

  describe('include/exclude filter lists', () => {
    const pathsOf = (result: { results: { path: string; locale: string }[] }) =>
      result.results.map((r) => `${r.locale}:${r.path}`).sort()

    before(async () => {
      const make = (path: string, overrides: Partial<PageInput> = {}) =>
        pagesModel.createPage(
          fixtures.siteId,
          pageInput({ path, title: 'Dugong Census', publishState: 'published', ...overrides }),
          actor
        )
      await make('wombat/alpha', { tags: ['red', 'old'] })
      await make('wombat/beta', { tags: ['red'], editor: 'code' })
      await make('wombat/private/gamma', { tags: ['blue'] })
      await make('wombat/delta', { locale: 'fr', tags: ['blue'] })
      await make('wombat/epsilon', { publishState: 'draft', tags: [] })
    })

    const base = () => ({ siteId: fixtures.siteId, query: 'dugong', includeDrafts: true })

    test('excludePath drops every page under any listed prefix, keeping totals exact', async () => {
      const excludePath = ['wombat/private', 'wombat/beta']
      const first = await searchModel.query({ ...base(), actor, excludePath, limit: 2 })
      assert.equal(first.totalHits, 3)
      assert.equal(first.results.length, 2)
      const second = await searchModel.query({ ...base(), excludePath, limit: 2, offset: 2 })
      assert.equal(second.results.length, 1)
      const seen = [...first.results, ...second.results].map((r) => r.path)
      assert.equal(seen.includes('wombat/private/gamma'), false)
      assert.equal(seen.includes('wombat/beta'), false)
    })

    test('several include paths are any-of', async () => {
      const result = await searchModel.query({
        ...base(),
        path: ['wombat/alpha', 'wombat/beta']
      })
      assert.deepEqual(pathsOf(result), ['en:wombat/alpha', 'en:wombat/beta'])
    })

    test('tags are all-of by default and any-of with tagsMatch any', async () => {
      const all = await searchModel.query({ ...base(), tags: ['red', 'blue'] })
      assert.deepEqual(pathsOf(all), [])
      const any = await searchModel.query({ ...base(), tags: ['old', 'blue'], tagsMatch: 'any' })
      assert.deepEqual(pathsOf(any), [
        'en:wombat/alpha',
        'en:wombat/private/gamma',
        'fr:wombat/delta'
      ])
    })

    test('excludeTags drops a page carrying any listed tag', async () => {
      const result = await searchModel.query({ ...base(), excludeTags: ['old', 'blue'] })
      assert.deepEqual(pathsOf(result), ['en:wombat/beta', 'en:wombat/epsilon'])
    })

    test('excludeLocales drops a locale, and combines with an include list', async () => {
      const result = await searchModel.query({ ...base(), excludeLocales: ['fr'] })
      assert.equal(
        result.results.some((r) => r.locale === 'fr'),
        false
      )
      assert.equal(result.totalHits, 4)
      const none = await searchModel.query({ ...base(), locales: ['fr'], excludeLocales: ['fr'] })
      assert.equal(none.totalHits, 0)
    })

    test('excludeEditor and editor lists', async () => {
      const without = await searchModel.query({ ...base(), excludeEditor: ['code'] })
      assert.equal(without.totalHits, 4)
      assert.equal(
        without.results.some((r) => r.path === 'wombat/beta'),
        false
      )
      const only = await searchModel.query({ ...base(), editor: ['code', 'wysiwyg'] })
      assert.deepEqual(pathsOf(only), ['en:wombat/beta'])
    })

    test('excludePublishState drops a state, and publishState accepts several', async () => {
      const without = await searchModel.query({ ...base(), excludePublishState: ['draft'] })
      assert.equal(without.totalHits, 4)
      const either = await searchModel.query({
        ...base(),
        publishState: ['draft', 'scheduled']
      })
      assert.deepEqual(pathsOf(either), ['en:wombat/epsilon'])
    })

    test('filters of different types AND together', async () => {
      const result = await searchModel.query({
        ...base(),
        path: ['wombat'],
        excludePath: ['wombat/private'],
        excludeTags: ['old'],
        excludeLocales: ['fr'],
        excludePublishState: ['draft']
      })
      assert.deepEqual(pathsOf(result), ['en:wombat/beta'])
    })

    test('creatorId and authorId lists filter by the page owner', async () => {
      const stranger = randomUUID()
      const everyone = await searchModel.query({ ...base(), creatorId: [fixtures.userId] })
      assert.equal(everyone.totalHits, 5)
      const byAuthor = await searchModel.query({ ...base(), authorId: [stranger, fixtures.userId] })
      assert.equal(byAuthor.totalHits, 5)
      const nobody = await searchModel.query({ ...base(), creatorId: [stranger] })
      assert.equal(nobody.totalHits, 0)
      const dropped = await searchModel.query({ ...base(), excludeAuthorId: [fixtures.userId] })
      assert.equal(dropped.totalHits, 0)
      const kept = await searchModel.query({ ...base(), excludeCreatorId: [stranger] })
      assert.equal(kept.totalHits, 5)
    })
  })

  /** `suggestTitle()` is private; `query()`'s `suggestion` field is the only way in. */
  describe('"did you mean" suggestions', () => {
    let readerActor: PageActor
    let blockedActor: PageActor

    before(async () => {
      /** `manage:system` short-circuits `checkAccess()`. */
      readerActor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      /** No groups and no `manage:system`: `checkAccess()` denies every page permission. */
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
        actor: blockedActor
      })
      assert.equal(result.totalHits, 0)
      assert.equal(result.suggestion, null)
    })
  })

  /**
   * A reader whose page rules deny part of a matching set must still get full, non-overlapping
   * pages when walking `offset` forward in `limit`-sized steps — the property the over-fetch loop
   * in `query()` exists to provide.
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
        Written directly rather than through `groups.updateGroup()`: its guest-role clamping reads
        `CARDINAL.data.systemIds.guestsGroupId`, which the DB-backed fixture never populates.
        `reloadCache()` is the same in-memory refresh `updateGroup()` triggers, so `checkAccess()`
        sees these rules exactly as it would after a real admin edit.
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
      // -> Titled so alphabetical order is predictable; every third page lives under the denied
      //    branch, leaving 8 of the 12 visible to this reader
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

      // -> Never shrunk below `limit` just because a denied row fell inside the raw window
      assert.equal(page1.results.length, 3)
      assert.equal(page2.results.length, 3)
      assert.equal(page3.results.length, 2)

      const seenPaths = [...page1.results, ...page2.results, ...page3.results].map((r) => r.path)

      assert.equal(new Set(seenPaths).size, seenPaths.length)
      assert.ok(seenPaths.every((p) => !p.startsWith('docs/hidden/')))
      assert.deepEqual(
        seenPaths.sort(),
        Array.from({ length: 12 }, (_, idx) => idx + 1)
          .filter((i) => i % 3 !== 0)
          .map((i) => `docs/open/paging-${i}`)
          .sort()
      )
    })

    /**
     * 32 denied rows sort before 4 visible ones (`H` < `V`), so the first candidate window comes
     * back with nothing surviving and the loop has to widen it before a page can be filled at all.
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
   * Mock-based rather than DB-backed: a site-scoped rule cannot tell one site's results from
   * another's unless the page ref handed to `checkAccess` carries `siteId`, and proving it reaches
   * that call is a pure wiring check with no SQL in it.
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
   * Mock-based, same reasoning as the suite above: `totalHitsApproximate` is decided purely by
   * comparing row counts either side of the `checkAccess` filter, so a fake two-row response covers
   * both branches faster than real page rules would. The DB-backed suite covers those.
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
