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

let siteForUpdate: any
const updateSiteCalls: Array<{ id: string; patch: Record<string, any> }> = []
let enabledSiteCount = 1

async function getSiteById({ id }: { id: string }) {
  return id === siteForUpdate?.id ? siteForUpdate : null
}

async function updateSite(id: string, patch: Record<string, any>) {
  updateSiteCalls.push({ id, patch })
  return true
}

async function countEnabledSites() {
  return enabledSiteCount
}

before(async () => {
  ;(globalThis as any).WIKI = {
    logger: { warn: () => {} },
    models: {
      sites: {
        getSiteByHostname,
        getSiteById,
        isHostnameUnique,
        createSite,
        updateSite,
        countEnabledSites
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

test('an uppercase hostname is rejected by the schema and never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: 'WIKI.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('a hostname with a colon (port suffix) is rejected by the schema and never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: 'wiki.example.org:8080', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

/**
 * Regression coverage for duplicate-hostname / duplicate-catch-all rejection: `POST /_api/sites`
 * checks `isHostnameUnique` before ever calling `createSite`, and picks between two distinct error
 * messages depending on whether the rejected hostname was `*` or an ordinary one.
 */

test('a duplicate ordinary hostname is rejected with the duplicate-hostname message, never reaching createSite', async () => {
  hostnamesTakenByUnique.add('taken.example.org')
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: 'taken.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /duplicate hostname/i)
  assert.equal(createSiteCalls.length, 0)
})

test('a duplicate catch-all hostname is rejected with the duplicate-catch-all message, never reaching createSite', async () => {
  hostnamesTakenByUnique.add('*')
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { hostname: '*', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /catch-all/i)
  assert.equal(createSiteCalls.length, 0)
})

/**
 * Regression coverage for the last leg of task 699/702's disabled-site contract: unlike the read
 * routes gated elsewhere in this feature, `PUT /:siteId` (behind `manage:sites`) must keep succeeding
 * against an already-disabled site — otherwise nobody could ever flip `isEnabled` back on.
 */

test('updating a disabled site still succeeds, so it can be re-enabled', async () => {
  updateSiteCalls.length = 0
  siteForUpdate = {
    id: '44444444-4444-4444-8444-444444444444',
    hostname: 'off.example.com',
    isEnabled: false,
    config: { title: 'Disabled Site' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${siteForUpdate.id}`,
    payload: { isEnabled: true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].id, siteForUpdate.id)
  assert.equal(updateSiteCalls[0].patch.isEnabled, true)
})

/**
 * Regression coverage for task 691: the DELETE route already refuses to remove the last remaining
 * site (`countSites() <= 1`); PUT had no equivalent, so an admin could disable the only enabled site
 * with `isEnabled: false` and leave the wiki with no hostname able to resolve. Mirrors the DELETE
 * guard's shape — a 409 conflict, `updateSite` never called — but keyed on `countEnabledSites()`
 * rather than `countSites()`, since a disabled site still exists, it just stops being served.
 */

test('disabling the only enabled site is refused with a 409 and never reaches updateSite', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 1
  siteForUpdate = {
    id: '55555555-5555-4555-8555-555555555555',
    hostname: 'only-enabled.example.com',
    isEnabled: true,
    config: { title: 'Only Enabled Site' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${siteForUpdate.id}`,
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().message, /last enabled site/i)
  assert.equal(updateSiteCalls.length, 0)
})

test('disabling a site is allowed when another site would remain enabled', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 2
  siteForUpdate = {
    id: '66666666-6666-4666-8666-666666666666',
    hostname: 'one-of-many.example.com',
    isEnabled: true,
    config: { title: 'One Of Many' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${siteForUpdate.id}`,
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].patch.isEnabled, false)
})

test('disabling an already-disabled site does not re-check the enabled count (no-op patch, not a conflict)', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 1
  siteForUpdate = {
    id: '77777777-7777-4777-8777-777777777777',
    hostname: 'already-off.example.com',
    isEnabled: false,
    config: { title: 'Already Off' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${siteForUpdate.id}`,
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})
