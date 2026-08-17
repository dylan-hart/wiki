import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import commentsRoutes from './comments.ts'
import { registerSchemas as registerCommentProviderSchema } from './schemas/commentProvider.ts'

/**
 * Route-level test for `GET/PUT /sites/:siteId/comments/providers` (Task 617, Feature 394).
 *
 * `WIKI.models.sites` and `WIKI.models.commentProviders` are stubbed rather than pulling in the real
 * db/schema/drizzle graph — `models/commentProviders.test.ts` is what covers the model's own logic
 * (discovery, sync, the single-active-provider invariant) against a real database. This file only
 * proves the route wiring: site existence checks, status codes, and how the model's return values and
 * thrown errors map onto the HTTP response.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const sites: Record<string, any> = {
  [SITE_ID]: { id: SITE_ID, hostname: 'test.localhost', isEnabled: true }
}

const ALPHA_PROVIDER = {
  id: 'provider-1',
  module: 'alpha',
  isEnabled: true,
  title: 'Alpha Provider',
  description: '',
  icon: '',
  vendor: '',
  website: '',
  isAvailable: true,
  props: {},
  config: {}
}

let setActiveProviderCalls: Array<{ siteId: string; module: string; config: Record<string, any> }>

async function getSiteById({ id }: { id: string }) {
  return sites[id] ?? null
}

async function getSiteProviders(siteId: string) {
  return siteId === SITE_ID ? [ALPHA_PROVIDER] : []
}

async function setActiveProvider(siteId: string, moduleKey: string, config: Record<string, any>) {
  setActiveProviderCalls.push({ siteId, module: moduleKey, config })
  if (moduleKey === 'ghost') {
    return null
  }
  if (moduleKey === 'invalid') {
    throw new Error('Some Prop must be a string.')
  }
  return { ...ALPHA_PROVIDER, module: moduleKey, config }
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: { getSiteById },
      commentProviders: { getSiteProviders, setActiveProvider }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerCommentProviderSchema(app)
  await app.register(commentsRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('GET .../comments/providers 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sites/00000000-0000-0000-0000-000000000000/comments/providers'
  })
  assert.equal(res.statusCode, 404)
})

test('GET .../comments/providers returns the site’s providers', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/comments/providers` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [ALPHA_PROVIDER])
})

test('PUT .../comments/providers 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/sites/00000000-0000-0000-0000-000000000000/comments/providers',
    payload: { module: 'alpha' }
  })
  assert.equal(res.statusCode, 404)
})

test('PUT .../comments/providers activates the named module with its config', async () => {
  setActiveProviderCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/comments/providers`,
    payload: { module: 'alpha', config: { apiKey: 'xyz' } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().module, 'alpha')
  assert.deepEqual(setActiveProviderCalls, [
    { siteId: SITE_ID, module: 'alpha', config: { apiKey: 'xyz' } }
  ])
})

test('PUT .../comments/providers 404s for a module nothing on disk declares', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/comments/providers`,
    payload: { module: 'ghost' }
  })
  assert.equal(res.statusCode, 404)
})

test('PUT .../comments/providers turns a model validation error into a 400', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/comments/providers`,
    payload: { module: 'invalid' }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /must be a string/)
})
