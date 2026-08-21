import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  seedLocale,
  type TestFixtures
} from '../test/db.ts'
import sitesRoutes from './sites.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import type { PageActor } from '../models/pages.ts'

/**
 * DB-backed route test for `PUT /:siteId`'s locale-deactivation guard (Task 995, decision doc Option
 * A item 5): deactivating a locale that still holds pages must be refused with a count naming it, not
 * silently orphan them (unreachable by URL, uncreatable, yet still surfacing in the file manager and
 * search).
 *
 * DB-backed rather than a stub, deliberately: the guard's whole job is counting real `pages` rows for
 * the removed locale(s), so a test that stubs the count would only prove the route calls a function,
 * not that the count is accurate. `api/sites.test.ts` stubs `WIKI.models.sites` entirely for its own
 * (large, long-running) suite and has no `WIKI.db` to query against, so this lives in its own file
 * rather than sharing that one's top-level mock — the same split `comments.admin.test.ts` documents
 * for itself alongside `comments.test.ts`.
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

      // -> `setupTestDb()` seeds the site's config with `locales.active: ['en', 'fr']` already, but
      //    the route's pre-existing installed/unknown-locale check (ahead of this one) reads the
      //    `locales` TABLE, which starts empty — without these two rows that check refuses the PUT
      //    with `siteUpdateUnknownLocale` before ever reaching the check under test here.
      await seedLocale(fixtures.db, { code: 'en' })
      await seedLocale(fixtures.db, { code: 'fr' })

      app = fastify({
        ajv: {
          plugins: [[ajvFormats.default, {}] as any],
          onCreate: (ajv: any) => {
            ajv.addFormat('hexcolor', (data: unknown) => {
              return (
                typeof data === 'string' &&
                /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
              )
            })
          }
        }
      })
      await app.register(fastifySensible)
      // -> Mirrors `index.ts`'s real `setErrorHandler`: a thrown `CustomError` is shaped into the
      //    `{ ok, error, statusCode, message }` body the assertions below read `error`/`message` off.
      app.setErrorHandler((error: any, _req, reply) => {
        reply.code(error.statusCode ?? 500).send({
          ok: false,
          error: error.name,
          statusCode: error.statusCode ?? 500,
          message: error.message
        })
      })
      await registerErrorSchema(app)
      await registerSiteSchema(app)
      app.addHook('onRequest', async (req) => {
        ;(req as any).session = testSession
      })
      await app.register(sitesRoutes)
      await app.ready()
    })

    after(async () => {
      await app.close()
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
