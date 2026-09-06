import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import metricsRoutes from './metrics.ts'
import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * Regression coverage for task 1842: `/metrics` used to build its snapshot from `await`
 * expressions inside one object literal, so each round trip waited on the previous one instead of
 * running concurrently. `WIKI.db.$count`/`WIKI.db.execute`/`WIKI.models.jobs.*` are stubbed to each
 * record when they were *called* and when they *resolved* into a shared `events` array, with a fixed
 * artificial delay before resolving — chosen so the assertion is deterministic either way rather than
 * racy: concurrent (`Promise.all`) calls every stub synchronously before any of them resolves, so
 * every 'start' event lands before the first 'end' event; serial (`await` chained) calls the next
 * stub only after the previous one resolves, so a 'start'/'end' pair interleaves immediately and the
 * first 'end' lands before the later 'start's. Unlike a countdown-latch/barrier stub (which would
 * simply hang forever on a serial regression instead of failing cleanly), this fixed-delay approach
 * fails fast and with a readable assertion either way.
 *
 * Task 1939 added `jobsFailed` (via `WIKI.models.jobs.countFailed()`, so it joins the same
 * `Promise.all` and the concurrency assertion below) and the three `dbPoolTotal`/`dbPoolIdle`/
 * `dbPoolWaiting` gauges (read synchronously off `WIKI.dbManager.pool`, not awaited, so they don't
 * join the concurrency count).
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
      config: { metrics: { isEnabled: true } },
      dbManager: { dbName: 'wiki_test', pool: { totalCount: 4, idleCount: 1, waitingCount: 0 } },
      models: {
        apiKeys: {
          verify: async () => ({ permissions: ['manage:system'] })
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
    await app.register(metricsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
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
