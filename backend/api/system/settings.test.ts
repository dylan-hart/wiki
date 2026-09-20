import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Every string asserted here is one a user or an auditor actually sees: exactly what building all
 * three routes from one `registerFlagToggle()` can quietly get wrong.
 */
const TOGGLES = [
  {
    configKey: 'api',
    auditEvent: 'system.apiStateUpdated',
    enabledMessage: 'API enabled successfully.',
    disabledMessage: 'API disabled successfully.',
    saveFailureMessage: 'Failed to save the API state.'
  },
  {
    configKey: 'metrics',
    auditEvent: 'system.metricsUpdated',
    enabledMessage: 'Metrics endpoint enabled successfully.',
    disabledMessage: 'Metrics endpoint disabled successfully.',
    saveFailureMessage: 'Failed to save the metrics endpoint state.'
  },
  {
    configKey: 'pageviews',
    auditEvent: 'system.pageviewsUpdated',
    enabledMessage: 'Pageview tracking enabled successfully.',
    disabledMessage: 'Pageview tracking disabled successfully.',
    saveFailureMessage: 'Failed to save the pageview tracking state.'
  }
] as const

describe('PUT /api | /metrics | /pageviews — the boolean flag toggles', () => {
  let app: FastifyInstance
  let saveToDb: ReturnType<typeof mock.fn>
  let record: ReturnType<typeof mock.fn>
  let config: Record<string, any>

  before(async () => {
    saveToDb = mock.fn(async () => true)
    record = mock.fn(async () => {})
    config = {
      api: { isEnabled: false, otherKey: 'kept' },
      metrics: { isEnabled: false, otherKey: 'kept' },
      pageviews: { isEnabled: false, otherKey: 'kept' }
    }
    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      session: {
        authenticated: true,
        user: { id: '11111111-1111-4111-8111-111111111111', name: 'Root' },
        permissions: ['manage:system']
      },
      wiki: {
        config,
        configSvc: { saveToDb: (...args: any[]) => saveToDb(...args) },
        models: {
          auditLog: { record: (...args: any[]) => record(...args) },
          pageviews: { summary: async () => ({}) }
        }
      }
    })
    // -> `buildTestApp`'s `wiki` is deep-merged over the stub defaults, so read the object the app
    //    actually installed rather than the literal above: the handlers mutate THAT one.
    config = (globalThis as any).CARDINAL.config
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    saveToDb.mock.resetCalls()
    saveToDb.mock.mockImplementation(async () => true)
    record.mock.resetCalls()
    for (const { configKey } of TOGGLES) {
      config[configKey] = { isEnabled: false, otherKey: 'kept' }
    }
  })

  for (const toggle of TOGGLES) {
    const { configKey } = toggle

    test(`PUT /${configKey} enables the flag, persists just its own config key, and answers its own message`, async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${configKey}`,
        payload: { isEnabled: true }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), {
        ok: true,
        message: toggle.enabledMessage,
        isEnabled: true
      })
      assert.equal(config[configKey].isEnabled, true)
      // -> Merged onto the previous config, not replacing it: a sibling key must survive the write.
      assert.equal(config[configKey].otherKey, 'kept')
      assert.equal(saveToDb.mock.callCount(), 1)
      assert.deepEqual(saveToDb.mock.calls[0]!.arguments[0], [configKey])
    })

    test(`PUT /${configKey} disables the flag and answers its own disabled message`, async () => {
      config[configKey] = { isEnabled: true, otherKey: 'kept' }
      const res = await app.inject({
        method: 'PUT',
        url: `/${configKey}`,
        payload: { isEnabled: false }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), {
        ok: true,
        message: toggle.disabledMessage,
        isEnabled: false
      })
      assert.equal(config[configKey].isEnabled, false)
      assert.equal(config[configKey].otherKey, 'kept')
    })

    test(`PUT /${configKey} records ${toggle.auditEvent} naming the actor and the new value`, async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${configKey}`,
        payload: { isEnabled: true }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(record.mock.callCount(), 1)
      const entry = record.mock.calls[0]!.arguments[0] as Record<string, any>
      assert.equal(entry.event, toggle.auditEvent)
      assert.equal(entry.actor.id, '11111111-1111-4111-8111-111111111111')
      assert.equal(entry.actor.name, 'Root')
      assert.deepEqual(entry.detail, { isEnabled: true })
    })

    test(`PUT /${configKey} rolls the in-memory config back and 500s when the save fails`, async () => {
      saveToDb.mock.mockImplementation(async () => false)
      const res = await app.inject({
        method: 'PUT',
        url: `/${configKey}`,
        payload: { isEnabled: true }
      })
      assert.equal(res.statusCode, 500)
      assert.equal(res.json().message, toggle.saveFailureMessage)
      assert.deepEqual(config[configKey], { isEnabled: false, otherKey: 'kept' })
      assert.equal(record.mock.callCount(), 0)
    })
  }

  test('a request without isEnabled is refused by the schema, before any config is touched', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api', payload: {} })
    assert.equal(res.statusCode, 400)
    assert.equal(saveToDb.mock.callCount(), 0)
    assert.equal(config.api.isEnabled, false)
  })
})

describe('GET /pageviews', () => {
  let app: FastifyInstance
  const FAKE_SUMMARY = {
    totalViews: 42,
    last24h: 3,
    last7d: 10,
    distinctPages: 7,
    mostRecentAt: '2026-08-31T00:00:00.000Z'
  }

  before(async () => {
    const wiki = {
      config: { pageviews: { isEnabled: true } },
      models: {
        pageviews: {
          summary: mock.fn(async () => FAKE_SUMMARY)
        }
      }
    }

    app = await buildTestApp({ routes: systemRoutes, ajv: true, wiki })
  })

  after(() => closeTestApp(app))

  test('returns isEnabled from config and summary from CARDINAL.models.pageviews.summary()', async () => {
    const res = await app.inject({ method: 'GET', url: '/pageviews' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.isEnabled, true)
    assert.deepEqual(body.summary, FAKE_SUMMARY)
  })
})
