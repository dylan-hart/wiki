import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import blockCredentialsRoutes from './blockCredentials.ts'
import { registerSchemas as registerBlockCredentialSchema } from './schemas/blockCredential.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * A unit-level test of the route's own wiring — site lookup, the `manage:sites`/`site:blocks` gate,
 * response shape — with `WIKI.models.sites`/`blockCredentials`/`groups` stubbed rather than a real
 * database, the same way `api/blocks.test.ts`'s PUT/DELETE suite covers `mayManageBlocks`.
 * `models/blockCredentials.test.ts` is what proves the model itself against a real database.
 */
describe('block credentials API (site-scoped delegation)', () => {
  const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
  const CREDENTIAL_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

  const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID } }
  async function getSiteById({ id }: { id: string }) {
    return sites[id] ?? null
  }

  let createCredentialCalls: Array<{
    siteId: string
    name: string
    secret: string
    allowedDomains: string[]
  }>
  let rotateSecretCalls: Array<{ siteId: string; id: string; secret: string }>
  let deleteCredentialCalls: Array<{ siteId: string; id: string }>
  let rotateSecretResult = true
  let deleteCredentialResult = true
  let updateAllowedDomainsCalls: Array<{ siteId: string; id: string; allowedDomains: string[] }>
  let updateAllowedDomainsResult = true

  async function getSiteCredentials(siteId: string) {
    return [
      {
        id: CREDENTIAL_ID,
        siteId,
        name: 'Weather API',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  }
  async function createCredential(
    siteId: string,
    name: string,
    secret: string,
    allowedDomains: string[]
  ) {
    createCredentialCalls.push({ siteId, name, secret, allowedDomains })
    return {
      id: 'new-credential-id',
      siteId,
      name,
      allowedDomains,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }
  async function rotateSecret(siteId: string, id: string, secret: string) {
    rotateSecretCalls.push({ siteId, id, secret })
    return rotateSecretResult
  }
  async function deleteCredential(siteId: string, id: string) {
    deleteCredentialCalls.push({ siteId, id })
    return deleteCredentialResult
  }
  async function updateAllowedDomains(siteId: string, id: string, allowedDomains: string[]) {
    updateAllowedDomainsCalls.push({ siteId, id, allowedDomains })
    return updateAllowedDomainsResult
  }

  /** Grants `site:blocks` only for the site id the `x-test-site-permissions` header names. */
  let currentSitePermissionHeader: string | undefined
  function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    return typeof currentSitePermissionHeader === 'string'
      ? currentSitePermissionHeader.split(',').filter(Boolean).includes(`${permission}@${siteId}`)
      : false
  }

  function actorForRequest(req: any) {
    const header = req.headers['x-test-permissions']
    const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
    return { groupIds: [], permissions }
  }

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        sites: { getSiteById },
        blockCredentials: {
          getSiteCredentials,
          createCredential,
          rotateSecret,
          updateAllowedDomains,
          deleteCredential
        },
        groups: { actorForRequest, checkSiteAccess }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerBlockCredentialSchema(app)
    app.addHook('preHandler', (req: any, reply, done) => {
      currentSitePermissionHeader = req.headers['x-test-site-permissions']
      done()
    })
    await app.register(blockCredentialsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    createCredentialCalls = []
    rotateSecretCalls = []
    deleteCredentialCalls = []
    rotateSecretResult = true
    deleteCredentialResult = true
    updateAllowedDomainsCalls = []
    updateAllowedDomainsResult = true
    currentSitePermissionHeader = undefined
  })

  test('rejects an actor with neither manage:sites nor site:blocks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: { 'x-test-permissions': '' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('404s when the site does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sites/00000000-0000-0000-0000-000000000000/block-credentials',
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('manage:sites may list credentials, secret never in the response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.length, 1)
    assert.equal(body[0].name, 'Weather API')
    assert.equal('secret' in body[0], false)
  })

  test('site:blocks on this site may create a credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: {
        'x-test-permissions': '',
        'x-test-site-permissions': `site:blocks@${SITE_ID}`
      },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: ['api.example.com'] }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createCredentialCalls.length, 1)
    assert.deepEqual(createCredentialCalls[0], {
      siteId: SITE_ID,
      name: 'Prod API',
      secret: 'sekret-abc',
      allowedDomains: ['api.example.com']
    })
    assert.equal('secret' in res.json(), false)
  })

  test('site:blocks granted for a different site does not carry over', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: {
        'x-test-permissions': '',
        'x-test-site-permissions': 'site:blocks@some-other-site'
      },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: ['api.example.com'] }
    })
    assert.equal(res.statusCode, 403)
  })

  test('rejects creating a credential with no allowed domains', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: [] }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(createCredentialCalls.length, 0)
  })

  test('rotate: 404s when the model reports no matching credential', async () => {
    rotateSecretResult = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/rotate`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { secret: 'new-secret' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('rotate: succeeds and threads the new secret to the model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/rotate`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { secret: 'new-secret' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(rotateSecretCalls, [
      { siteId: SITE_ID, id: CREDENTIAL_ID, secret: 'new-secret' }
    ])
  })

  test('delete: 404s when the model reports no matching credential', async () => {
    deleteCredentialResult = false
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('delete: succeeds with a 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(deleteCredentialCalls, [{ siteId: SITE_ID, id: CREDENTIAL_ID }])
  })

  test('update domains: 404s when the model reports no matching credential', async () => {
    updateAllowedDomainsResult = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: ['new.example.com'] }
    })
    assert.equal(res.statusCode, 404)
  })

  test('update domains: succeeds and threads the new list to the model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: ['new.example.com', '*.other.com'] }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateAllowedDomainsCalls, [
      { siteId: SITE_ID, id: CREDENTIAL_ID, allowedDomains: ['new.example.com', '*.other.com'] }
    ])
  })

  test('update domains: an empty list is accepted (deliberately disabling the credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: [] }
    })
    assert.equal(res.statusCode, 200)
  })

  test('update domains: requires manage:sites or site:blocks on this site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': '' },
      payload: { allowedDomains: ['new.example.com'] }
    })
    assert.equal(res.statusCode, 403)
  })
})
