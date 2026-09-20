import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  seedLocale,
  seedTreeEntry,
  type TestFixtures
} from '../test/db.ts'
import sitesRoutes from './sites.ts'
import type { PageActor } from '../models/pages.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * DB-backed rather than a stub: the guard's whole job is counting real `pages` rows for the removed
 * locales, so stubbing the count would only prove the route calls a function. Its own file because
 * `api/sites.test.ts` stubs `CARDINAL.models.sites` entirely and has no `CARDINAL.db` to query.
 */
describe(
  'PUT /:siteId — locale deactivation refuses to orphan pages (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let app: FastifyInstance
    let pagesModel: typeof import('../models/pages.ts').pages
    let actor: PageActor
    let testSession: any = null

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('../models/pages.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      // -> The route's installed-locale check runs first and reads the `locales` TABLE, which
      //    starts empty — without these rows it refuses the PUT with `siteUpdateUnknownLocale`
      //    before the check under test.
      await seedLocale(fixtures.db, { code: 'en' })
      await seedLocale(fixtures.db, { code: 'fr' })

      // -> No `wiki`: `setupTestDb()` already installed the real one.
      app = await buildTestApp({ routes: sitesRoutes, ajv: true, session: () => testSession })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('refuses with a 409 naming the locale and page count, then succeeds once the page is gone', async () => {
      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        permissions: ['manage:system']
      }

      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'french-notes',
          title: 'French notes',
          editor: 'markdown',
          content: 'x',
          locale: 'fr'
        },
        actor
      )

      const refused = await app.inject({
        method: 'PUT',
        url: `/${fixtures.siteId}`,
        payload: { locales: { active: ['en'] } }
      })
      assert.equal(refused.statusCode, 409)
      const refusedBody = refused.json()
      assert.equal(refusedBody.error, 'siteUpdateLocaleHasPages')
      assert.match(refusedBody.message, /fr \(1\)/)

      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const succeeded = await app.inject({
        method: 'PUT',
        url: `/${fixtures.siteId}`,
        payload: { locales: { active: ['en'] } }
      })
      assert.equal(succeeded.statusCode, 200)
      assert.equal(succeeded.json().ok, true)
    })
  }
)

describe('locale aliases (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let app: FastifyInstance

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'zh-CN' })
    await seedLocale(fixtures.db, { code: 'fr' })
    app = await buildTestApp({
      routes: sitesRoutes,
      ajv: true,
      session: () => ({
        authenticated: true,
        user: { id: fixtures.userId },
        permissions: ['manage:system']
      })
    })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const put = (locales: Record<string, any>) =>
    app.inject({ method: 'PUT', url: `/${fixtures.siteId}`, payload: { locales } })

  const storedLocales = async () => {
    const res = await app.inject({ method: 'GET', url: `/${fixtures.siteId}` })
    assert.equal(res.statusCode, 200)
    return res.json().locales
  }

  test('a valid alias round-trips, and deactivating its locale clears it', async () => {
    const saved = await put({ primary: 'en', active: ['en', 'zh-CN'], aliases: { 'zh-CN': 'zh' } })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual((await storedLocales()).aliases, { 'zh-CN': 'zh' })

    const unrelated = await put({ showMenu: false })
    assert.equal(unrelated.statusCode, 200)
    assert.deepEqual((await storedLocales()).aliases, { 'zh-CN': 'zh' })

    const deactivated = await put({ active: ['en'] })
    assert.equal(deactivated.statusCode, 200)
    assert.deepEqual((await storedLocales()).aliases, {})
  })

  test('an alias is refused while a root page or folder starts with that segment', async () => {
    await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'docs', type: 'folder' })
    await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'docs/intro' })
    await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'notes/deep/page' })

    const active = ['en', 'zh-CN']
    for (const alias of ['docs', 'DOCS', 'notes']) {
      const refused = await put({ active, aliases: { 'zh-CN': alias } })
      assert.equal(refused.statusCode, 409, alias)
      assert.equal(refused.json().error, 'siteUpdateAliasCollidesWithContent', alias)
    }

    const accepted = await put({ active, aliases: { 'zh-CN': 'deep' } })
    assert.equal(accepted.statusCode, 200)
  })
})
