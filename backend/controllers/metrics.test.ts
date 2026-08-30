import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import metricsRoutes from './metrics.ts'
import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'

/**
 * Regression coverage for task 1842: `/metrics` used to build its snapshot from six `await`
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
    ;(globalThis as any).WIKI = {
      config: { metrics: { isEnabled: true } },
      dbManager: { dbName: 'wiki_test' },
      models: {
        apiKeys: {
          verify: async () => ({ permissions: ['manage:system'] })
        },
        jobs: {
          countActive: () => record('activeWorkers', 3),
          countPending: () => record('jobsQueued', 7)
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
    }

    app = fastify()
    await app.register(metricsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('issues all six lookups concurrently, not serially', async () => {
    events = []

    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer irrelevant-in-this-stub' }
    })

    assert.equal(res.statusCode, 200)

    const starts = events.filter((e) => e.startsWith('start:'))
    const firstEndIndex = events.findIndex((e) => e.startsWith('end:'))

    assert.equal(starts.length, 6, `expected all six lookups to have been called, got: ${events}`)
    assert.equal(
      firstEndIndex,
      6,
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
        '# HELP wikijs_active_workers Jobs currently executing, across every instance connected to this database.',
        '# TYPE wikijs_active_workers gauge',
        'wikijs_active_workers 3',
        '# HELP wikijs_pages_total Total number of pages.',
        '# TYPE wikijs_pages_total gauge',
        'wikijs_pages_total 11',
        '# HELP wikijs_users_total Total number of user accounts.',
        '# TYPE wikijs_users_total gauge',
        'wikijs_users_total 5',
        '# HELP wikijs_groups_total Total number of groups.',
        '# TYPE wikijs_groups_total gauge',
        'wikijs_groups_total 2',
        '# HELP wikijs_instances_total Instances currently connected to this database.',
        '# TYPE wikijs_instances_total gauge',
        'wikijs_instances_total 0',
        '# HELP wikijs_jobs_queued Jobs waiting in the queue, not yet claimed by a worker.',
        '# TYPE wikijs_jobs_queued gauge',
        'wikijs_jobs_queued 7',
        ''
      ].join('\n')
    )
  })
})
