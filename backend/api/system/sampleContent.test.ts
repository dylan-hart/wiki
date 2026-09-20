import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import sampleContentRoutes from './sampleContent.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../test/db.ts'
import {
  auditLog as auditLogTable,
  pages as pagesTable,
  tree as treeTable
} from '../../db/schema.ts'
import {
  SAMPLE_CONTENT_PATH_PREFIX,
  SAMPLE_CONTENT_TAG,
  SAMPLE_PAGES
} from '../../models/sampleContent.ts'

describe('sample content routes: access control', () => {
  let app: FastifyInstance
  const siteId = randomUUID()
  const payload = { siteId }

  before(async () => {
    app = await buildTestApp({
      routes: sampleContentRoutes,
      ajv: true,
      permissions: true,
      session: 'header',
      wiki: { models: {} }
    })
  })

  after(() => closeTestApp(app))

  for (const url of ['/sampleContent/generate', '/sampleContent/purge']) {
    test(`${url} answers 401 to an anonymous caller`, async () => {
      const res = await app.inject({ method: 'POST', url, payload })
      assert.equal(res.statusCode, 401)
    })

    test(`${url} answers 403 to a caller without manage:system`, async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { 'x-test-permissions': 'manage:sites,manage:pages' }
      })
      assert.equal(res.statusCode, 403)
    })
  }

  test('a malformed siteId is rejected before the model is reached', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sampleContent/generate',
      payload: { siteId: 'not-a-uuid' },
      headers: { 'x-test-permissions': 'manage:system' }
    })
    assert.equal(res.statusCode, 400)
  })
})

describe('sample content routes (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let app: FastifyInstance
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    app = await buildTestApp({
      routes: sampleContentRoutes,
      ajv: true,
      permissions: true,
      session: {
        authenticated: true,
        user: { id: fixtures.userId, name: 'Fixture Admin' },
        permissions: ['manage:system'],
        groups: []
      }
    })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  beforeEach(async () => {
    await fixtures.db.delete(pagesTable)
    await fixtures.db.delete(treeTable)
    await fixtures.db.delete(auditLogTable)
  })

  const generate = () =>
    app.inject({
      method: 'POST',
      url: '/sampleContent/generate',
      payload: { siteId: fixtures.siteId }
    })
  const purge = () =>
    app.inject({
      method: 'POST',
      url: '/sampleContent/purge',
      payload: { siteId: fixtures.siteId }
    })

  async function allPaths(): Promise<string[]> {
    const rows = await fixtures.db.select({ path: pagesTable.path }).from(pagesTable)
    return rows.map((row) => row.path).sort()
  }

  async function createRealPage(path: string, tags: string[]) {
    return CARDINAL.models.pages.createPage(
      fixtures.siteId,
      { path, title: `Page ${path}`, editor: 'markdown', content: '# Real', tags },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
  }

  test('generate generates the sample pages and reports the count', async () => {
    const res = await generate()
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.count, SAMPLE_PAGES.length)
    assert.deepEqual(await allPaths(), SAMPLE_PAGES.map((sample) => sample.path).sort())

    const rows = await fixtures.db.select().from(pagesTable)
    for (const row of rows) {
      assert.ok(row.tags.includes(SAMPLE_CONTENT_TAG))
    }
  })

  test('generate records an audit entry against the site', async () => {
    await generate()
    const entries = await fixtures.db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, 'system.sampleContentGenerated'))
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.siteId, fixtures.siteId)
    assert.equal(entries[0]!.actorId, fixtures.userId)
  })

  test('generate a second time is refused with a 409 and creates nothing more', async () => {
    const first = await generate()
    assert.equal(first.statusCode, 200)
    const second = await generate()
    assert.equal(second.statusCode, 409)
    assert.equal(second.json().ok, false)
    assert.equal((await allPaths()).length, SAMPLE_PAGES.length)
  })

  test('generate over a real page at a sample path fails without overwriting it', async () => {
    const [first] = SAMPLE_PAGES
    await createRealPage(first!.path, [])
    const res = await generate()
    assert.ok(res.statusCode >= 400 && res.statusCode < 500)
    const [row] = await fixtures.db.select().from(pagesTable)
    assert.equal(row!.title, `Page ${first!.path}`)
    assert.ok(!row!.tags.includes(SAMPLE_CONTENT_TAG))
  })

  test('purge removes the generated pages and reports the count', async () => {
    await generate()
    const res = await purge()
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.count, SAMPLE_PAGES.length)
    assert.deepEqual(await allPaths(), [])

    const entries = await fixtures.db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, 'system.sampleContentPurged'))
    assert.equal(entries.length, 1)
  })

  test('purge does not delete a real page, even one tagged test or under the prefix', async () => {
    await createRealPage('docs/real-page', [])
    await createRealPage('docs/tagged-test', ['test'])
    await createRealPage('docs/reserved-tag-only', [SAMPLE_CONTENT_TAG])
    await createRealPage(`${SAMPLE_CONTENT_PATH_PREFIX}hand-written`, ['test'])

    await generate()
    const res = await purge()
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().count, SAMPLE_PAGES.length)

    assert.deepEqual(await allPaths(), [
      'docs/real-page',
      'docs/reserved-tag-only',
      'docs/tagged-test',
      `${SAMPLE_CONTENT_PATH_PREFIX}hand-written`
    ])
  })

  test('an unknown site is a 404 for both routes', async () => {
    const payload = { siteId: randomUUID() }
    for (const url of ['/sampleContent/generate', '/sampleContent/purge']) {
      const res = await app.inject({ method: 'POST', url, payload })
      assert.equal(res.statusCode, 404)
    }
  })

  test('purge with nothing generated answers a count of zero', async () => {
    const res = await purge()
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().count, 0)
  })

  test('generate, purge and generate again works', async () => {
    assert.equal((await generate()).statusCode, 200)
    assert.equal((await purge()).statusCode, 200)
    assert.equal((await generate()).statusCode, 200)
  })
})
