import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import sitesRoutes from '../../api/sites.ts'
import { registerSchemas as registerSiteSchema } from '../../api/schemas/site.ts'
import { registerSchemas as registerErrorSchema } from '../../api/schemas/error.ts'

/**
 * Regression test for a pre-existing bug in `GET /_api/sites/:siteIdorHostname`: the handler read
 * `strict` off `(req as any).querystring?.strict`, a property Fastify never populates (the parsed
 * query string is `req.query`), so the flag was always `undefined` and a caller asking for a strict
 * hostname match silently fell back to the wildcard site instead. Fixed by reading `req.query.strict`
 * through a typed `Querystring` generic.
 *
 * `WIKI.models.sites.getSiteByHostname` is stubbed here rather than imported from `models/sites.ts`,
 * so the test stays a self-contained unit test of the route's querystring wiring rather than pulling
 * in the db/schema and drizzle graph. The stub reproduces the real model's strict-vs-wildcard
 * semantics exactly (see `models/sites.ts`), which is what makes the 404/200 assertions below
 * meaningful.
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

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteByHostname,
        getSiteById: async () => null
      },
      rendering: {
        isAvailable: async () => true
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
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`badRequest()`/etc. is a
  //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
  //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerErrorSchema(app)
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
