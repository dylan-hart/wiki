import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import type { FastifyInstance } from 'fastify'
import metricsRoutes from './metrics.ts'
import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

const metricsConfig = { isEnabled: true }
let verifyStub: (token: string) => Promise<{ permissions: string[] }> = async () => ({
  permissions: ['manage:system']
})

/**
 * Each stub records when it was called and, after a fixed delay, when it resolved. Issued
 * concurrently, every 'start' lands before the first 'end'; issued serially, they interleave. A fixed
 * delay rather than a latch/barrier stub, which would hang forever on a serial regression instead of
 * failing with a readable assertion.
 */
describe('GET /metrics', () => {
  const DELAY_MS = 20

  let events: string[]

  function record<T>(name: string, value: T): Promise<T> {
    events.push(`start:${name}`)
    return new Promise((resolve) => {
      setTimeout(() => {
        events.push(`end:${name}`)
        resolve(value)
      }, DELAY_MS)
    })
  }

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      config: { metrics: metricsConfig },
      dbManager: { dbName: 'wiki_test', pool: { totalCount: 4, idleCount: 1, waitingCount: 0 } },
      models: {
        apiKeys: {
          verify: (token: string) => verifyStub(token)
        },
        jobs: {
          countActive: () => record('activeWorkers', 3),
          countPending: () => record('jobsQueued', 7),
          countFailed: () => record('jobsFailed', 1)
        }
      },
      db: {
        $count: (table: unknown) => {
          if (table === pagesTable) return record('pagesTotal', 11)
          if (table === usersTable) return record('usersTotal', 5)
          if (table === groupsTable) return record('groupsTotal', 2)
          throw new Error('unexpected table passed to $count')
        },
        execute: () => record('instancesTotal', { rows: [] })
      }
    })

    app = fastify()
    await app.register(fastifySensible)
    await app.register(metricsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  const SCRAPE = { method: 'GET', url: '/', headers: { authorization: 'Bearer any' } } as const

  describe('access', () => {
    const ADMIN = async () => ({ permissions: ['manage:system'] })

    beforeEach(() => {
      events = []
    })

    after(() => {
      verifyStub = ADMIN
      metricsConfig.isEnabled = true
    })

    test('a key holding read:metrics alone scrapes', async () => {
      verifyStub = async () => ({ permissions: ['read:metrics'] })
      const res = await app.inject(SCRAPE)
      assert.equal(res.statusCode, 200)
    })

    test('a key holding manage:system alone still scrapes', async () => {
      verifyStub = ADMIN
      const res = await app.inject(SCRAPE)
      assert.equal(res.statusCode, 200)
    })

    test('a key holding neither permission gets 403', async () => {
      verifyStub = async () => ({ permissions: ['read:users', 'manage:groups', 'read:pages'] })
      const res = await app.inject(SCRAPE)
      assert.equal(res.statusCode, 403)
    })

    test('a key whose scope removed read:metrics from its owner gets 403', async () => {
      verifyStub = async () => ({ permissions: [] })
      const res = await app.inject(SCRAPE)
      assert.equal(res.statusCode, 403)
    })

    test('a revoked or expired key is refused with 401 and its reason', async () => {
      for (const reason of ['API key has been revoked.', 'API key has expired.']) {
        verifyStub = async () => {
          throw new Error(reason)
        }
        const res = await app.inject(SCRAPE)
        assert.equal(res.statusCode, 401)
        assert.match(res.body, new RegExp(reason.replace('.', '\\.')))
      }
    })

    test('a missing bearer token gets 401', async () => {
      verifyStub = async () => ({ permissions: ['read:metrics'] })
      const res = await app.inject({ method: 'GET', url: '/' })
      assert.equal(res.statusCode, 401)
    })

    test('flag off is 404 even for a key that would otherwise scrape', async () => {
      verifyStub = async () => ({ permissions: ['read:metrics', 'manage:system'] })
      metricsConfig.isEnabled = false
      try {
        assert.equal((await app.inject(SCRAPE)).statusCode, 404)
        assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 404)
      } finally {
        metricsConfig.isEnabled = true
      }
    })
  })

  test('issues all seven lookups concurrently, not serially', async () => {
    events = []

    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer irrelevant-in-this-stub' }
    })

    assert.equal(res.statusCode, 200)

    const starts = events.filter((e) => e.startsWith('start:'))
    const firstEndIndex = events.findIndex((e) => e.startsWith('end:'))

    assert.equal(starts.length, 7, `expected all seven lookups to have been called, got: ${events}`)
    assert.equal(
      firstEndIndex,
      7,
      `expected every lookup to be issued before any of them resolved, got order: ${events}`
    )
  })

  test('renders the same Prometheus exposition as the serial version', async () => {
    events = []

    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer irrelevant-in-this-stub' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8')
    assert.equal(
      res.body,
      [
        '# HELP cardinaljs_active_workers Jobs currently executing, across every instance connected to this database.',
        '# TYPE cardinaljs_active_workers gauge',
        'cardinaljs_active_workers 3',
        '# HELP cardinaljs_pages_total Total number of pages.',
        '# TYPE cardinaljs_pages_total gauge',
        'cardinaljs_pages_total 11',
        '# HELP cardinaljs_users_total Total number of user accounts.',
        '# TYPE cardinaljs_users_total gauge',
        'cardinaljs_users_total 5',
        '# HELP cardinaljs_groups_total Total number of groups.',
        '# TYPE cardinaljs_groups_total gauge',
        'cardinaljs_groups_total 2',
        '# HELP cardinaljs_instances_total Instances currently connected to this database.',
        '# TYPE cardinaljs_instances_total gauge',
        'cardinaljs_instances_total 0',
        '# HELP cardinaljs_jobs_queued Jobs waiting in the queue, not yet claimed by a worker.',
        '# TYPE cardinaljs_jobs_queued gauge',
        'cardinaljs_jobs_queued 7',
        '# HELP cardinaljs_jobs_failed_total Failed jobs currently retained in job history. Not a lifetime total: rows age out under the configured job history retention window, so this can decrease as well as increase between scrapes.',
        '# TYPE cardinaljs_jobs_failed_total gauge',
        'cardinaljs_jobs_failed_total 1',
        '# HELP cardinaljs_db_pool_total Total clients (idle + in use) in the database connection pool.',
        '# TYPE cardinaljs_db_pool_total gauge',
        'cardinaljs_db_pool_total 4',
        '# HELP cardinaljs_db_pool_idle Idle clients in the database connection pool, available to be checked out.',
        '# TYPE cardinaljs_db_pool_idle gauge',
        'cardinaljs_db_pool_idle 1',
        '# HELP cardinaljs_db_pool_waiting Queries currently waiting for a client to become available in the database connection pool.',
        '# TYPE cardinaljs_db_pool_waiting gauge',
        'cardinaljs_db_pool_waiting 0',
        ''
      ].join('\n')
    )
  })
})
