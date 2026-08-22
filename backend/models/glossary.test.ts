import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `models/glossary.ts` is almost entirely SQL — an insert with a case-insensitive uniqueness
 * constraint, an update, a delete, and a join resolving each term's canonical page to a link — so a
 * mock of the query builder would mostly be re-describing the code under test rather than verifying
 * it. This suite runs the real methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('glossary CRUD + cache (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let glossaryModel: typeof import('./glossary.ts').glossary
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ glossary: glossaryModel } = await import('./glossary.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'docs/api',
      title: 'API Docs',
      editor: 'markdown',
      content: '# API',
      ...overrides
    }
  }

  test('createTerm() + listTerms() round-trip, alphabetical', async () => {
    await glossaryModel.createTerm(fixtures.siteId, { term: 'Zulu', definition: 'Last letter.' })
    await glossaryModel.createTerm(fixtures.siteId, { term: 'Alpha', definition: 'First letter.' })

    const terms = await glossaryModel.listTerms(fixtures.siteId)
    const names = terms.map((t) => t.term)
    assert.ok(names.indexOf('Alpha') < names.indexOf('Zulu'))
  })

  test('createTerm() rejects an empty term', async () => {
    await assert.rejects(
      () => glossaryModel.createTerm(fixtures.siteId, { term: '   ', definition: 'Something.' }),
      /cannot be empty/
    )
  })

  test('createTerm() rejects an empty definition', async () => {
    await assert.rejects(
      () => glossaryModel.createTerm(fixtures.siteId, { term: 'Something', definition: '  ' }),
      /cannot be empty/
    )
  })

  test('createTerm() rejects a case-insensitive duplicate of an existing term', async () => {
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'API',
      definition: 'First definition.'
    })

    await assert.rejects(async () => {
      try {
        await glossaryModel.createTerm(fixtures.siteId, { term: 'api', definition: 'Second.' })
      } catch (err: any) {
        assert.equal(err.statusCode, 409)
        throw err
      }
    }, /already exists/)
  })

  test('createTerm() rejects a pageId that does not exist on this site', async () => {
    await assert.rejects(async () => {
      try {
        await glossaryModel.createTerm(fixtures.siteId, {
          term: 'Orphan',
          definition: 'Points nowhere.',
          pageId: '00000000-0000-0000-0000-000000000000'
        })
      } catch (err: any) {
        assert.equal(err.statusCode, 400)
        throw err
      }
    }, /does not exist/)
  })

  test('createTerm() accepts a pageId that belongs to this site', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-1' }),
      actor
    )

    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Linked Term',
      definition: 'Has a canonical page.',
      pageId: page.id
    })

    assert.equal(created.pageId, page.id)
  })

  test('updateTerm() updates the fields given and leaves the rest untouched', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Original',
      definition: 'Original definition.'
    })

    const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, {
      definition: 'Updated definition.'
    })

    assert.equal(updated.term, 'Original')
    assert.equal(updated.definition, 'Updated definition.')
  })

  test('updateTerm() can clear a canonical page by setting pageId to null', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-2' }),
      actor
    )
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Unlink Me',
      definition: 'Will lose its page.',
      pageId: page.id
    })

    const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, { pageId: null })

    assert.equal(updated.pageId, null)
  })

  test('updateTerm() rejects an id that does not exist', async () => {
    await assert.rejects(async () => {
      try {
        await glossaryModel.updateTerm(fixtures.siteId, '00000000-0000-0000-0000-000000000000', {
          definition: 'Anything.'
        })
      } catch (err: any) {
        assert.equal(err.statusCode, 404)
        throw err
      }
    }, /does not exist/)
  })

  test('deleteTerm() removes the row and reports true, false when nothing was there', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Deletable',
      definition: 'Gone soon.'
    })

    assert.equal(await glossaryModel.deleteTerm(fixtures.siteId, created.id), true)
    assert.equal(await glossaryModel.deleteTerm(fixtures.siteId, created.id), false)
    assert.equal(await glossaryModel.getTerm(fixtures.siteId, created.id), null)
  })

  test('getCachedTerms() resolves a canonical page to a locale-aware link, and null without one', async () => {
    const enPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cached-en', locale: 'en' }),
      actor
    )
    const frPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cached-fr', locale: 'fr' }),
      actor
    )
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheEn',
      definition: 'English page link.',
      pageId: enPage.id
    })
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheFr',
      definition: 'French page link.',
      pageId: frPage.id
    })
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheNone',
      definition: 'No canonical page.'
    })

    const cached = await glossaryModel.getCachedTerms(fixtures.siteId)
    const byTerm = Object.fromEntries(cached.map((t) => [t.term, t]))

    // -> The fixture site's primary locale is 'en' (test/db.ts), so an 'en' page link carries no
    //    locale prefix while the non-primary 'fr' one does — see `localizedPagePath`.
    assert.equal(byTerm.CacheEn!.link, '/docs/cached-en')
    assert.equal(byTerm.CacheFr!.link, '/fr/docs/cached-fr')
    assert.equal(byTerm.CacheNone!.link, null)
  })

  test('a write invalidates the cache: the next read sees the change, not a stale one', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Mutable',
      definition: 'Before update.'
    })
    const before = await glossaryModel.getCachedTerms(fixtures.siteId)
    assert.equal(before.find((t) => t.term === 'Mutable')?.definition, 'Before update.')

    await glossaryModel.updateTerm(fixtures.siteId, created.id, { definition: 'After update.' })

    const after = await glossaryModel.getCachedTerms(fixtures.siteId)
    assert.equal(after.find((t) => t.term === 'Mutable')?.definition, 'After update.')
  })

  test('a second read within the cache window hits the cache rather than the database', async () => {
    await glossaryModel.createTerm(fixtures.siteId, { term: 'CacheHit', definition: 'Cached.' })
    await glossaryModel.getCachedTerms(fixtures.siteId)
    const getCallsBefore = (WIKI.cache.get as any).mock.callCount()

    await glossaryModel.getCachedTerms(fixtures.siteId)

    assert.equal((WIKI.cache.get as any).mock.callCount(), getCallsBefore + 1)
  })
})
