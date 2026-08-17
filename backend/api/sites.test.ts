import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import sitesRoutes from './sites.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'

/**
 * Regression test for `GET /_api/sites/:siteIdorHostname`'s `strict` querystring flag: the handler
 * read `(req as any).querystring?.strict`, a property Fastify never populates (the parsed query
 * string is `req.query`), so `strict` was always `undefined` and a caller asking for an exact
 * hostname match silently fell back to the wildcard site instead of getting a 404. Fixed by reading
 * `req.query.strict` through the route's existing `Querystring` generic.
 *
 * `WIKI.models.sites.getSiteByHostname` is stubbed to reproduce the real model's strict-vs-wildcard
 * semantics (see `models/sites.ts`) rather than pulling in the db/schema/drizzle graph, keeping this
 * a self-contained unit test of the route's querystring wiring.
 */

const WILDCARD_SITE_ID = 'wildcard-site-id'
const sitesMappings: Record<string, string> = { '*': WILDCARD_SITE_ID }
const sites: Record<string, any> = {
  [WILDCARD_SITE_ID]: {
    id: WILDCARD_SITE_ID,
    hostname: '*',
    isEnabled: true,
    config: { title: 'Wildcard Site' }
  }
}

async function getSiteByHostname({
  hostname,
  strict = false
}: {
  hostname: string
  strict?: boolean
}) {
  const siteId = strict ? sitesMappings[hostname] : sitesMappings[hostname] || sitesMappings['*']
  return siteId ? sites[siteId] : null
}

let app: FastifyInstance

const createSiteCalls: Array<{ hostname: string; config: Record<string, any> }> = []
let hostnamesTakenByUnique: Set<string>

async function isHostnameUnique(hostname: string) {
  return !hostnamesTakenByUnique.has(hostname)
}

async function createSite(hostname: string, config: Record<string, any>) {
  createSiteCalls.push({ hostname, config })
  return { id: 'new-site-id' }
}

before(async () => {
  ;(globalThis as any).WIKI = {
    logger: { warn: () => {} },
    models: {
      sites: {
        getSiteByHostname,
        getSiteById: async () => null,
        isHostnameUnique,
        createSite
      }
    }
  }

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
  await registerSiteSchema(app)
  await app.register(sitesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('strict=true does not fall back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com?strict=true'
  })
  assert.equal(res.statusCode, 404)
})

test('omitting strict falls back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().hostname, '*')
})

test('strict=false falls back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com?strict=false'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().hostname, '*')
})

/**
 * Regression test for `POST /_api/sites`'s hand-rolled hostname check: the handler validated
 * `req.body.hostname` against `/^(\*)|([a-z0-9\-.:]+)$/`, but the alternation is ungrouped and the
 * first branch (`\*` — zero or more literal backslashes) matches the empty string, so the whole
 * expression is always true regardless of what follows it — `''` and `'<script>'` both pass. The
 * check never actually validated anything; it was redundant with (and looser than) the body schema's
 * own `pattern: '^(\*|[a-z0-9.-]+)$'`, which Fastify's ajv already enforces before the handler runs.
 * Fixed by deleting the dead hand-rolled check and relying solely on the schema.
 */

beforeEach(() => {
  createSiteCalls.length = 0
  hostnamesTakenByUnique = new Set()
})

test('a schema-valid hostname creates the site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: 'wiki.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(createSiteCalls, [
    { hostname: 'wiki.example.org', config: { title: 'My Wiki' } }
  ])
})

test('a hostname the schema rejects never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: '<script>', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('an empty hostname never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: '', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('the catch-all wildcard hostname is still accepted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: '*', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createSiteCalls[0]?.hostname, '*')
})
