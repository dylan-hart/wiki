import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import {
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  tree as treeTable
} from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import {
  generate,
  isSampleContentAlreadyGenerated,
  purge,
  SAMPLE_CONTENT_PATH_PREFIX,
  SAMPLE_CONTENT_TAG,
  SAMPLE_PAGES
} from './sampleContent.ts'

describe('sample content generate and purge (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(async () => {
    await fixtures.db.delete(pagesTable)
    await fixtures.db.delete(treeTable)
  })

  async function createPlainPage(path: string, tags: string[]) {
    return CARDINAL.models.pages.createPage(
      fixtures.siteId,
      { path, title: `Page ${path}`, editor: 'markdown', content: '# Body', tags },
      actor
    )
  }

  async function allPaths(): Promise<string[]> {
    const rows = await fixtures.db.select({ path: pagesTable.path }).from(pagesTable)
    return rows.map((row) => row.path).sort()
  }

  test('the reserved constants and page list are consistent', () => {
    assert.ok(SAMPLE_PAGES.length >= 1)
    for (const sample of SAMPLE_PAGES) {
      assert.ok(sample.path.startsWith(SAMPLE_CONTENT_PATH_PREFIX))
    }
  })

  test('generate creates every sample page, marked with the reserved tag', async () => {
    const result = await generate(fixtures.siteId, actor)

    assert.equal(result.created, SAMPLE_PAGES.length)
    assert.deepEqual(result.paths.sort(), SAMPLE_PAGES.map((sample) => sample.path).sort())

    const rows = await fixtures.db.select().from(pagesTable)
    assert.equal(rows.length, SAMPLE_PAGES.length)
    for (const row of rows) {
      assert.ok(row.path.startsWith(SAMPLE_CONTENT_PATH_PREFIX))
      assert.ok(row.tags.includes(SAMPLE_CONTENT_TAG))
      assert.equal(row.siteId, fixtures.siteId)
    }
  })

  test('generate goes through createPage, so tree and history rows exist', async () => {
    await generate(fixtures.siteId, actor)

    const rows = await fixtures.db.select().from(pagesTable)
    for (const row of rows) {
      const tree = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, row.id))
      assert.equal(tree.length, 1)
      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, row.id))
      assert.equal(history.length, 1)
      assert.equal(history[0]!.action, 'created')
    }
  })

  test('generate refuses with a distinguishable error when sample content already exists', async () => {
    await generate(fixtures.siteId, actor)
    const before = await allPaths()

    await assert.rejects(generate(fixtures.siteId, actor), (err: any) => {
      assert.equal(isSampleContentAlreadyGenerated(err), true)
      assert.equal(err.statusCode, 409)
      return true
    })
    assert.deepEqual(await allPaths(), before)
  })

  test('an unrelated error is not reported as already generated', () => {
    assert.equal(isSampleContentAlreadyGenerated(new Error('boom')), false)
    assert.equal(isSampleContentAlreadyGenerated(undefined), false)
  })

  test('generate surfaces the duplicate-path error instead of overwriting a real page', async () => {
    const samplePath = SAMPLE_PAGES[0]!.path
    const real = await createPlainPage(samplePath, ['docs'])

    await assert.rejects(generate(fixtures.siteId, actor), (err: any) => {
      assert.equal(err.name, 'pageDuplicatePath')
      assert.equal(isSampleContentAlreadyGenerated(err), false)
      return true
    })

    const rows = await fixtures.db.select().from(pagesTable)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, real.id)
    assert.deepEqual(rows[0]!.tags, ['docs'])
  })

  test('purge removes the generated pages and their tree entries', async () => {
    await generate(fixtures.siteId, actor)

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: SAMPLE_PAGES.length, deleted: SAMPLE_PAGES.length })
    assert.deepEqual(await allPaths(), [])
    const pageTreeRows = await fixtures.db
      .select()
      .from(treeTable)
      .where(eq(treeTable.type, 'page'))
    assert.equal(pageTreeRows.length, 0)
  })

  test('purge leaves hand-tagged and partially marked pages untouched', async () => {
    await generate(fixtures.siteId, actor)
    const handTagged = await createPlainPage('notes/hand-tagged', ['test'])
    const tagOnly = await createPlainPage('notes/tag-only', [SAMPLE_CONTENT_TAG])
    const prefixOnly = await createPlainPage(`${SAMPLE_CONTENT_PATH_PREFIX}my-own-page`, ['docs'])
    const prefixWithTest = await createPlainPage(`${SAMPLE_CONTENT_PATH_PREFIX}my-test-page`, [
      'test'
    ])

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: SAMPLE_PAGES.length, deleted: SAMPLE_PAGES.length })
    const remaining = await fixtures.db.select({ id: pagesTable.id }).from(pagesTable)
    assert.deepEqual(
      remaining.map((row) => row.id).sort(),
      [handTagged.id, tagOnly.id, prefixOnly.id, prefixWithTest.id].sort()
    )
  })

  test('a page that carries the reserved tag outside the prefix is never purged', async () => {
    const outside = await createPlainPage('elsewhere/welcome/page', [SAMPLE_CONTENT_TAG])
    const lookalike = await createPlainPage('welcomes/page', [SAMPLE_CONTENT_TAG])

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: 0, deleted: 0 })
    const remaining = await fixtures.db.select({ id: pagesTable.id }).from(pagesTable)
    assert.deepEqual(remaining.map((row) => row.id).sort(), [outside.id, lookalike.id].sort())
  })

  test('purge with nothing to remove reports zero counts', async () => {
    assert.deepEqual(await purge(fixtures.siteId, actor), { found: 0, deleted: 0 })
  })

  test('generate works again after a purge', async () => {
    await generate(fixtures.siteId, actor)
    await purge(fixtures.siteId, actor)

    const result = await generate(fixtures.siteId, actor)

    assert.equal(result.created, SAMPLE_PAGES.length)
    assert.deepEqual(await allPaths(), SAMPLE_PAGES.map((sample) => sample.path).sort())
  })
})
