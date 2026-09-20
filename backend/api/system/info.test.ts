import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { ensureTemporal } from '../../test/temporal.ts'

await ensureTemporal()

describe('GET /cluster (renamed from /instances)', () => {
  const FAKE_ROWS = [
    {
      usename: 'wiki',
      client_addr: '10.0.0.1',
      application_name: 'Cardinal.js - aaaaaaaaaa:MAIN',
      backend_start: '2026-08-17 09:00:00.000000+00',
      state_change: '2026-08-17 09:05:00.000000+00'
    },
    {
      usename: 'wiki',
      client_addr: '10.0.0.1',
      application_name: 'Cardinal.js - aaaaaaaaaa:PUBSUB',
      backend_start: '2026-08-17 09:00:00.000000+00',
      state_change: '2026-08-17 09:05:30.000000+00'
    },
    {
      usename: 'wiki',
      client_addr: '10.0.0.2',
      application_name: 'Cardinal.js - bbbbbbbbbb:MAIN',
      backend_start: '2026-08-17 09:01:00.000000+00',
      state_change: '2026-08-17 09:06:00.000000+00'
    }
  ]

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: systemRoutes,
      wiki: {
        dbManager: {
          dbName: 'wiki_test'
        },
        db: {
          execute: async () => ({ rows: FAKE_ROWS })
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('GET /cluster lists cluster nodes grouped by instance id (not /instances)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/cluster'
    })
    assert.equal(res.statusCode, 200)
    const nodes = res.json()
    assert.equal(nodes.length, 2)
    const nodeA = nodes.find((n: any) => n.id === 'aaaaaaaaaa')
    assert.ok(nodeA, 'expected the two aaaaaaaaaa connections to be grouped into one node')
    assert.equal(nodeA.activeConnections, 1)
    assert.equal(nodeA.activeListeners, 1)
  })

  test('GET /instances no longer exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/instances'
    })
    assert.equal(res.statusCode, 404)
  })
})

/**
 * A fixed character offset would silently slice a garbled id out of every row the day the product
 * name changes length, so this drives the handler with a differently-sized prefix.
 */
describe('GET /cluster parses the instance id by separator, not by offset', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: systemRoutes,
      wiki: {
        dbManager: { dbName: 'wiki_test' },
        db: {
          execute: async () => ({
            rows: [
              {
                usename: 'wiki',
                client_addr: '10.0.0.1',
                application_name: 'Q - 0123456789:MAIN',
                backend_start: '2026-08-17 09:00:00.000000+00',
                state_change: '2026-08-17 09:05:00.000000+00'
              }
            ]
          })
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('the id is everything between " - " and ":", whatever precedes it', async () => {
    const res = await app.inject({ method: 'GET', url: '/cluster' })
    assert.equal(res.statusCode, 200)
    const nodes = res.json()
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].id, '0123456789')
    assert.equal(nodes[0].activeConnections, 1)
  })
})

/**
 * Fastify serializes through the response schema (fast-json-stringify), so a property the handler
 * returns but the schema does not declare is silently dropped from the wire. These assert on the
 * serialized body for that reason.
 */
describe('GET /info', () => {
  let app: FastifyInstance

  before(async () => {
    const wiki = {
      version: '3.0.0-test',
      config: {
        db: { host: 'db-test-host' },
        api: { isEnabled: true },
        metrics: { isEnabled: false },
        pageviews: { isEnabled: true },
        mail: { host: '' },
        update: { version: '3.0.1', versionDate: '2026-01-01T00:00:00.000Z' },
        port: 3042
      },
      dbManager: { VERSION: '17.4', dbName: 'wiki_test' },
      db: {
        $count: async () => 7,
        execute: async () => ({ rows: [] })
      },
      models: {
        jobs: {
          countActive: async () => 2,
          isHealthy: async () => true
        },
        mail: {
          hasResolvableBaseURL: () => false
        }
      }
    }

    app = await buildTestApp({ routes: systemRoutes, ajv: true, wiki })
  })

  after(() => closeTestApp(app))

  test('GET /info includes dbVersion in the actual serialized response', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.dbVersion, '17.4')
  })

  test('GET /info reports the real configured port, not a hardcoded 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.httpPort, 3042)
  })

  test('GET /info reports isPageviewsEnabled from config, not hardcoded', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.isPageviewsEnabled, true)
  })

  test('GET /info reports isMailBaseURLConfigured from models.mail.hasResolvableBaseURL(), not hardcoded (OpenProject #3386)', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.isMailBaseURLConfigured, false)
  })
})

describe('POST /checkForUpdate', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: systemRoutes,
      wiki: {
        version: '3.0.0',
        config: { offline: true, update: {} },
        scheduler: { addJob: async () => ({ promise: Promise.resolve() }) }
      }
    })
  })

  after(() => closeTestApp(app))

  test('reports offline so the dialog can say so instead of showing blank release fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/checkForUpdate' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { current: '3.0.0', offline: true })
  })
})
