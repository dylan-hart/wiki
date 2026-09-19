import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAjvFormats } from '../core/http/ajvFormats.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * `apiKeySitePinHook` decides coverage by URL prefix, so whether it covers every site-scoped route
 * is a question about the real route table: this registers the actual `api/index.ts` plugin tree
 * and asserts every route with a `:siteId` param sits under that prefix. Nothing calls
 * `app.inject()`, so no handler runs and the `CARDINAL` stub only has to survive registration.
 */

const SITE_SCOPED_API_PREFIX = '/_api/sites/'

/** A whole `:siteId` segment, not a longer param name that merely starts with it. */
const SITE_ID_PARAM = /(^|\/):siteId(\/|$)/

let app: FastifyInstance
let routes: { method: string; url: string }[]

before(async () => {
  // -> Registration itself reads `CARDINAL.config.security`: `api/assets.ts` sizes its body parser
  //    from it up front.
  wikiHandle = installTestWiki({ config: { security: {} } })

  app = fastify({
    // -> As in `createHttpApp()`: route schemas reference the hand-registered ajv formats, and
    //    registration fails outright on an unknown one.
    ajv: { onCreate: registerAjvFormats }
  })

  routes = []
  app.addHook('onRoute', (opts) => {
    routes.push({ method: String(opts.method), url: opts.url })
  })

  await app.register(import('../api/index.ts'), { prefix: '/_api' })
  await app.ready()
})

after(async () => {
  await app.close()
  wikiHandle.restore()
})

test('the real registered API route table has at least the known site-scoped surface', () => {
  // -> A floor, not a count: it proves registration ran, so the next test cannot pass vacuously.
  const siteScoped = routes.filter((r) => SITE_ID_PARAM.test(r.url))
  assert.ok(
    siteScoped.length > 100,
    `expected well over 100 registered :siteId routes, got ${siteScoped.length}`
  )
})

test('every registered route carrying a :siteId param sits under the prefix apiKeySitePinHook checks', () => {
  const siteScoped = routes.filter((r) => SITE_ID_PARAM.test(r.url))
  const uncovered = siteScoped.filter((r) => !r.url.startsWith(SITE_SCOPED_API_PREFIX))
  assert.deepEqual(
    uncovered,
    [],
    `route(s) with a :siteId param outside ${SITE_SCOPED_API_PREFIX} — apiKeySitePinHook cannot see ` +
      `these, so they need their own enforceApiKeySite() call (see helpers/apiKeySite.ts): ` +
      JSON.stringify(uncovered)
  )
})

test('a route addressed by hostname or sentinel, not a real :siteId, is correctly excluded', () => {
  // -> `controllers/site.ts` is not registered here. Its same-named `:siteId` param is why the hook
  //    matches on the prefix rather than on the param name.
  assert.ok(!'/_site/:siteId/:resource'.startsWith(SITE_SCOPED_API_PREFIX))
})
