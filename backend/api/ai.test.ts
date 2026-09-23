import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { toMerged } from 'es-toolkit/object'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { SENSITIVE_CONFIG_MASK } from '../helpers/moduleProps.ts'
import { ai } from '../models/ai.ts'
import { installTestWiki } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { buildSitePayload } from './sites.ts'
import aiRoutes from './ai.ts'

const SITE_ID = '11111111-1111-4111-8111-111111111111'
const UNKNOWN_SITE_ID = '22222222-2222-4222-8222-222222222222'
const SECRET = 'sk-route-test-secret'

const FAKE_DEFINITION = `key: fake
title: Fake AI
description: A test provider.
vendor: Test
website: https://example.test
props:
  apiKey:
    type: String
    title: API Key
    sensitive: true
    required: true
    order: 1
  model:
    type: String
    title: Model
    default: fake-model-1
    order: 2
`

const NOCODE_DEFINITION = `key: nocode
title: No Code AI
description: A definition with no implementation.
vendor: Test
website: https://example.test
props:
  apiKey:
    type: String
    sensitive: true
    required: true
`

const ADMIN = JSON.stringify(['manage:system'])
const SITE_ADMIN = JSON.stringify(['manage:sites'])

let serverPath: string
let app: FastifyInstance
let sites: Record<string, any>
let auditCalls: any[]
let updateSucceeds: boolean

function freshSites() {
  return {
    [SITE_ID]: {
      id: SITE_ID,
      isEnabled: true,
      config: { title: 'A Site', ai: { provider: '', providers: {} } }
    }
  }
}

before(async () => {
  serverPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-ai-api-'))
  await fs.mkdir(path.join(serverPath, 'modules/ai/fake'), { recursive: true })
  await fs.mkdir(path.join(serverPath, 'modules/ai/nocode'), { recursive: true })
  await fs.writeFile(path.join(serverPath, 'modules/ai/fake/definition.yml'), FAKE_DEFINITION)
  await fs.writeFile(path.join(serverPath, 'modules/ai/fake/ai.ts'), 'export default null\n')
  await fs.writeFile(path.join(serverPath, 'modules/ai/nocode/definition.yml'), NOCODE_DEFINITION)

  sites = freshSites()
  const wiki = {
    SERVERPATH: serverPath,
    get sites() {
      return sites
    },
    models: {
      ai,
      auditLog: {
        record: async (entry: any) => {
          auditCalls.push(entry)
        }
      },
      sites: {
        updateSite: async (siteId: string, patch: { config?: Record<string, any> }) => {
          if (!updateSucceeds || !sites[siteId]) {
            return false
          }
          sites[siteId].config = toMerged(sites[siteId].config, patch.config ?? {})
          return true
        }
      }
    }
  }

  const guardedRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('preHandler', siteEnabledPreHandler)
    await instance.register(aiRoutes)
  }

  app = await buildTestApp({
    routes: guardedRoutes,
    ajv: true,
    wiki,
    session: 'header',
    permissions: true
  })
  await ai.refreshFromDisk()
})

after(async () => {
  await closeTestApp(app)
  await fs.rm(serverPath, { recursive: true, force: true })
})

beforeEach(() => {
  sites = freshSites()
  auditCalls = []
  updateSucceeds = true
})

function listProviders(permissions = ADMIN, siteId = SITE_ID) {
  return app.inject({
    method: 'GET',
    url: `/sites/${siteId}/ai/providers`,
    headers: { 'x-test-permissions': permissions }
  })
}

function putAi(payload: Record<string, any>, permissions = ADMIN, siteId = SITE_ID) {
  return app.inject({
    method: 'PUT',
    url: `/sites/${siteId}/ai`,
    headers: { 'x-test-permissions': permissions },
    payload
  })
}

describe('GET /sites/:siteId/ai/providers', () => {
  test('refuses a caller without manage:system, manage:sites included', async () => {
    assert.equal((await listProviders(SITE_ADMIN)).statusCode, 403)
  })

  test('refuses an anonymous caller', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/ai/providers` })
    assert.equal(res.statusCode, 401)
  })

  test('404s for a site that does not exist', async () => {
    assert.equal((await listProviders(ADMIN, UNKNOWN_SITE_ID)).statusCode, 404)
  })

  test('lists every provider with the API key masked', async () => {
    sites[SITE_ID].config.ai = { provider: 'fake', providers: { fake: { apiKey: SECRET } } }
    const res = await listProviders()
    assert.equal(res.statusCode, 200)
    assert.ok(!res.body.includes(SECRET))
    const body = res.json()
    assert.deepEqual(
      body.map((p: any) => [p.key, p.isSelected, p.hasImplementation]),
      [
        ['fake', true, true],
        ['nocode', false, false]
      ]
    )
    assert.deepEqual(body[0].config, { apiKey: SENSITIVE_CONFIG_MASK, model: 'fake-model-1' })
    assert.equal(body[0].props.apiKey.sensitive, true)
  })
})

describe('PUT /sites/:siteId/ai', () => {
  test('refuses a caller without manage:system', async () => {
    const res = await putAi({ provider: 'fake', config: { apiKey: SECRET } }, SITE_ADMIN)
    assert.equal(res.statusCode, 403)
    assert.deepEqual(sites[SITE_ID].config.ai, { provider: '', providers: {} })
  })

  test('requires a provider field', async () => {
    assert.equal((await putAi({})).statusCode, 400)
  })

  test('404s for a provider nothing declares', async () => {
    assert.equal((await putAi({ provider: 'nope', config: {} })).statusCode, 404)
  })

  test('refuses a provider with no implementation', async () => {
    const res = await putAi({ provider: 'nocode', config: { apiKey: SECRET } })
    assert.equal(res.statusCode, 400)
    assert.equal(sites[SITE_ID].config.ai.provider, '')
  })

  test('refuses a config missing the required API key, writing nothing', async () => {
    const res = await putAi({ provider: 'fake', config: { model: 'x' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /API Key/)
    assert.deepEqual(sites[SITE_ID].config.ai, { provider: '', providers: {} })
    assert.equal(auditCalls.length, 0)
  })

  test('refuses an undeclared config key', async () => {
    const res = await putAi({ provider: 'fake', config: { apiKey: SECRET, bogus: 1 } })
    assert.equal(res.statusCode, 400)
  })

  test('selects the provider and stores its config', async () => {
    const res = await putAi({ provider: 'fake', config: { apiKey: SECRET, model: 'big' } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.deepEqual(sites[SITE_ID].config.ai, {
      provider: 'fake',
      providers: { fake: { apiKey: SECRET, model: 'big' } }
    })
    assert.equal(auditCalls.length, 1)
    assert.equal(auditCalls[0].event, 'site.settingsUpdated')
    assert.deepEqual(auditCalls[0].detail, { changedFields: ['ai'], provider: 'fake' })
    assert.ok(!JSON.stringify(auditCalls).includes(SECRET))
  })

  test('a masked API key sent back keeps the stored key', async () => {
    sites[SITE_ID].config.ai = { provider: 'fake', providers: { fake: { apiKey: SECRET } } }
    const listed = (await listProviders()).json()
    const res = await putAi({ provider: 'fake', config: { ...listed[0].config, model: 'm2' } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(sites[SITE_ID].config.ai.providers.fake, { apiKey: SECRET, model: 'm2' })
  })

  test('an empty provider turns AI off and keeps the stored provider config', async () => {
    sites[SITE_ID].config.ai = { provider: 'fake', providers: { fake: { apiKey: SECRET } } }
    const res = await putAi({ provider: '' })
    assert.equal(res.statusCode, 200)
    assert.equal(sites[SITE_ID].config.ai.provider, '')
    assert.equal(sites[SITE_ID].config.ai.providers.fake.apiKey, SECRET)
  })

  test('500s when the site could not be written', async () => {
    updateSucceeds = false
    const res = await putAi({ provider: 'fake', config: { apiKey: SECRET } })
    assert.equal(res.statusCode, 500)
    assert.equal(auditCalls.length, 0)
  })
})

test('buildSitePayload never carries config.ai, the API keys included', async () => {
  const wikiHandle = installTestWiki({
    config: {},
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: { getActiveProvider: async () => null }
    }
  })
  try {
    const payload = await buildSitePayload({
      id: SITE_ID,
      hostname: 'example.test',
      isEnabled: true,
      config: {
        title: 'A Site',
        features: { browse: true },
        locales: { primary: 'en', active: ['en'] },
        ai: { provider: 'fake', providers: { fake: { apiKey: SECRET } } }
      }
    })
    assert.ok(!('ai' in payload), '`ai` must never reach the public site payload')
    assert.ok(!JSON.stringify(payload).includes(SECRET))
  } finally {
    wikiHandle.restore()
  }
})
