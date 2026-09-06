import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Route-level test for `GET /system/extensions/status`.
 *
 * The frontend gates page-import on the Pandoc extension being installed (`PageNewMenu.vue` /
 * `ImportPageDialog.vue`, per task 668), and needs to ask that without `manage:system` — the
 * permission the full `/extensions` listing requires, since that route also carries install
 * eligibility and instructions meant for admins. This route is the "lightweight … check" the task
 * called for: no route-level permissions (open to any caller, like the public site-info route), and
 * answering nothing but `{ <extensionKey>: isInstalled }` for every declared extension.
 */
describe('GET /system/extensions/status', () => {
  let app: FastifyInstance
  let getExtensions: ReturnType<typeof mock.fn>

  before(async () => {
    getExtensions = mock.fn(async () => [
      {
        key: 'pandoc',
        title: 'Pandoc',
        isInstalled: true,
        isInstallable: false,
        isCompatible: true
      },
      {
        key: 'puppeteer',
        title: 'Puppeteer',
        isInstalled: false,
        isInstallable: true,
        isCompatible: true
      }
    ])

    const wiki = {
      models: {
        extensions: {
          getExtensions
        }
      }
    }

    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      wiki,
      session: (req: any) =>
        req.headers['x-test-anon'] === 'true'
          ? undefined
          : { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getExtensions.mock.resetCalls()
  })

  // -> The plain "answers a key -> isInstalled map" test was removed by OpenProject #2690
  //    (`docs/testing-audit/backend.md`'s `api/system/extensions.test.ts` row): it restated the
  //    handler's own return shape. The test below is the one with independent value — it also
  //    proves the same shape, but as evidence of the deliberate "no route-level permission" design
  //    decision, not as an end in itself.
  test('answers an anonymous caller too — no route-level permission gates it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/extensions/status',
      headers: { 'x-test-anon': 'true' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { pandoc: true, puppeteer: false })
  })
})
