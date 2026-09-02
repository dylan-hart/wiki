import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import ajvFormats from 'ajv-formats'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * Structural coverage check for OpenProject #2189/#2194: `apiKeySitePinHook`
 * (`helpers/apiKeySite.ts`) is registered once, globally, in `index.ts` and refuses a mismatched
 * site pin for any request whose URL starts with `/_api/sites/` — see that file's own doc comment
 * for why the prefix, rather than the `:siteId` param name alone, is what decides coverage
 * (`controllers/site.ts`'s `/:siteId/:resource` shares the param name but not the prefix, and its
 * `:siteId` can be the literal sentinel `'current'` rather than a real site id).
 *
 * That means "does the hook cover every site-scoped route" is a question about the REAL, registered
 * route table, not about the hook's own logic (`apiKeySite.test.ts` already covers that in
 * isolation against a handful of representative routes). This test registers the actual
 * `api/index.ts` plugin tree — the same one `index.ts` mounts at `/_api` — into a bare fastify
 * instance, collects every route Fastify actually built via `onRoute`, and asserts that every one
 * carrying a `:siteId` param sits under the exact prefix the hook checks. A future route that adds
 * a `:siteId` param under some OTHER prefix (a typo'd registration, a new controller mounted
 * outside `/_api/sites`) fails this test rather than silently shipping unprotected — the "so a
 * newly added route cannot silently regress the control" the work package's own description asks
 * for.
 *
 * No database and no real `WIKI` global beyond what plugin REGISTRATION touches (route/schema
 * declarations only — see the stub below): nothing here ever calls `app.inject()`, so no route
 * handler ever actually runs.
 */

const SITE_SCOPED_API_PREFIX = '/_api/sites/'

/** Matches a `:siteId` path segment exactly — not `:siteIdorHostname` or similar look-alikes. */
const SITE_ID_PARAM = /(^|\/):siteId(\/|$)/

let app: FastifyInstance
let routes: { method: string; url: string }[]

before(async () => {
  // -> Only what `api/index.ts`'s plugin tree touches at REGISTRATION time (not per-request) --
  //    `api/assets.ts` reads `WIKI.config.security?.uploadMaxFileSize` once, up front, to size its
  //    raw-body content-type parser.
  wikiHandle = installTestWiki({ config: { security: {} } })

  app = fastify({
    // -> Mirrors `index.ts`'s own fastify() options for the same reason it needs them: several
    //    schemas (e.g. a site's theme color) use the custom `hexcolor` ajv format, and route
    //    registration fails outright building a schema that references an unknown format.
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
  // -> A floor, not an exact count: the real number moves as routes are added, and pinning it
  //    exactly would make this test require an edit for every unrelated new endpoint. What matters
  //    for THIS test is that route registration actually ran (a regression collapsing it to near-zero
  //    would otherwise pass the loop below vacuously) and that the known site-scoped families are
  //    present.
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
  // -> `controllers/site.ts` is not registered here at all (it mounts at `/_site`, a separate
  //    controller outside `api/index.ts`'s tree) -- this just documents, for a future reader of this
  //    file, that its `:siteId` param sharing the same name is exactly why the prefix check above
  //    (not a param-name check) is what `apiKeySitePinHook` uses.
  assert.ok(!'/_site/:siteId/:resource'.startsWith(SITE_SCOPED_API_PREFIX))
})
