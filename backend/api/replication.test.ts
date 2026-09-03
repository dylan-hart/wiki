import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import replicationRoutes from './replication.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `GET|PUT /_api/replication/config` — the instance-level replication settings panel (OpenProject
 * #2491). Only the settings CRUD/validation is under test here: the actual bulk-export/import wire
 * protocol (#2489/#2490) and the scheduler wiring that reads `cronSchedule` (#2492) are separate work
 * with no route surface of their own yet.
 */

let app: FastifyInstance
let recordMock: ReturnType<typeof mock.fn>

before(async () => {
  app = await buildTestApp({
    routes: replicationRoutes,
    prefix: '/replication',
    wiki: {
      models: {
        auditLog: {
          record: (...args: any[]) => recordMock(...args)
        }
      },
      config: {
        replication: {}
      },
      configSvc: {
        saveToDb: mock.fn(async () => true)
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  recordMock = mock.fn(async () => {})
  WIKI.config.replication = {}
  WIKI.configSvc.saveToDb = mock.fn(async () => true)
})

/**
 * GET — masking
 */

test('returns an empty config with no bearerToken masking when nothing is stored', async () => {
  const res = await app.inject({ method: 'GET', url: '/replication/config' })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    isEnabled: false,
    sourceUrl: '',
    bearerToken: '',
    cronSchedule: ''
  })
})

test('masks a stored bearerToken on GET', async () => {
  WIKI.config.replication = {
    isEnabled: true,
    sourceUrl: 'https://prod.example.com',
    bearerToken: 'super-secret-token',
    cronSchedule: '0 0 * * 0'
  }

  const res = await app.inject({ method: 'GET', url: '/replication/config' })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.bearerToken, '********')
  assert.equal(body.sourceUrl, 'https://prod.example.com')
  assert.equal(body.isEnabled, true)
})

/**
 * PUT — masking round trip
 */

test('echoing the bearerToken mask on PUT leaves the stored token byte-identical', async () => {
  WIKI.config.replication = {
    isEnabled: true,
    sourceUrl: 'https://prod.example.com',
    bearerToken: 'super-secret-token',
    cronSchedule: '0 0 * * 0'
  }

  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { bearerToken: '********' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.replication.bearerToken, 'super-secret-token')
})

test('PUT with a new bearerToken overwrites the stored token', async () => {
  WIKI.config.replication = {
    isEnabled: true,
    sourceUrl: 'https://prod.example.com',
    bearerToken: 'old-token',
    cronSchedule: '0 0 * * 0'
  }

  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { bearerToken: 'new-token' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.replication.bearerToken, 'new-token')
})

test('never writes the raw bearerToken to the audit log', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { bearerToken: 'super-secret-token' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(recordMock.mock.calls.length, 1)
  const arg = recordMock.mock.calls[0].arguments[0] as any
  const detail = arg.detail
  assert.equal(detail.bearerToken, '********')
})

/**
 * PUT — validation
 */

test('rejects an invalid sourceUrl', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { sourceUrl: 'not-a-url' }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /valid.*URL/i)
})

test('rejects an invalid cronSchedule', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { cronSchedule: 'not a cron expression' }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /cron/i)
})

test('accepts a valid cronSchedule', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { cronSchedule: '0 0 * * 0' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.replication.cronSchedule, '0 0 * * 0')
})

test('rejects enabling replication with no sourceUrl, bearerToken or cronSchedule set', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { isEnabled: true }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /source instance URL/i)
})

test('rejects enabling replication with a sourceUrl but no bearerToken or cronSchedule', async () => {
  WIKI.config.replication = { sourceUrl: 'https://prod.example.com' }

  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { isEnabled: true }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /bearer token/i)
})

test('allows enabling replication once sourceUrl, bearerToken and cronSchedule are all set', async () => {
  WIKI.config.replication = {
    sourceUrl: 'https://prod.example.com',
    bearerToken: 'a-token',
    cronSchedule: '0 0 * * 0'
  }

  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { isEnabled: true }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.replication.isEnabled, true)
})

test('strips a trailing slash from sourceUrl', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { sourceUrl: 'https://prod.example.com/' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.replication.sourceUrl, 'https://prod.example.com')
})

test('answers 500 and rolls back in-memory config when saveToDb fails', async () => {
  WIKI.config.replication = { sourceUrl: 'https://old.example.com' }
  WIKI.configSvc.saveToDb = mock.fn(async () => false)

  const res = await app.inject({
    method: 'PUT',
    url: '/replication/config',
    payload: { sourceUrl: 'https://new.example.com' }
  })

  assert.equal(res.statusCode, 500)
  assert.equal(WIKI.config.replication.sourceUrl, 'https://old.example.com')
})
