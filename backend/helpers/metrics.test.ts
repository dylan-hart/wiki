import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPrometheusMetrics, type MetricsSnapshot } from './metrics.ts'

const snapshot: MetricsSnapshot = {
  activeWorkers: 2,
  pagesTotal: 431,
  usersTotal: 17,
  groupsTotal: 4,
  instancesTotal: 3,
  jobsQueued: 0,
  jobsFailed: 1,
  dbPoolTotal: 10,
  dbPoolIdle: 8,
  dbPoolWaiting: 0
}

describe('formatPrometheusMetrics', () => {
  test('writes one HELP/TYPE/value triplet per metric, in a stable order', () => {
    const body = formatPrometheusMetrics(snapshot)
    assert.equal(
      body,
      [
        '# HELP cardinaljs_active_workers Jobs currently executing, across every instance connected to this database.',
        '# TYPE cardinaljs_active_workers gauge',
        'cardinaljs_active_workers 2',
        '# HELP cardinaljs_pages_total Total number of pages.',
        '# TYPE cardinaljs_pages_total gauge',
        'cardinaljs_pages_total 431',
        '# HELP cardinaljs_users_total Total number of user accounts.',
        '# TYPE cardinaljs_users_total gauge',
        'cardinaljs_users_total 17',
        '# HELP cardinaljs_groups_total Total number of groups.',
        '# TYPE cardinaljs_groups_total gauge',
        'cardinaljs_groups_total 4',
        '# HELP cardinaljs_instances_total Instances currently connected to this database.',
        '# TYPE cardinaljs_instances_total gauge',
        'cardinaljs_instances_total 3',
        '# HELP cardinaljs_jobs_queued Jobs waiting in the queue, not yet claimed by a worker.',
        '# TYPE cardinaljs_jobs_queued gauge',
        'cardinaljs_jobs_queued 0',
        '# HELP cardinaljs_jobs_failed_total Failed jobs currently retained in job history. Not a lifetime total: rows age out under the configured job history retention window, so this can decrease as well as increase between scrapes.',
        '# TYPE cardinaljs_jobs_failed_total gauge',
        'cardinaljs_jobs_failed_total 1',
        '# HELP cardinaljs_db_pool_total Total clients (idle + in use) in the database connection pool.',
        '# TYPE cardinaljs_db_pool_total gauge',
        'cardinaljs_db_pool_total 10',
        '# HELP cardinaljs_db_pool_idle Idle clients in the database connection pool, available to be checked out.',
        '# TYPE cardinaljs_db_pool_idle gauge',
        'cardinaljs_db_pool_idle 8',
        '# HELP cardinaljs_db_pool_waiting Queries currently waiting for a client to become available in the database connection pool.',
        '# TYPE cardinaljs_db_pool_waiting gauge',
        'cardinaljs_db_pool_waiting 0',
        ''
      ].join('\n')
    )
  })

  test('every metric name is prefixed and valid Prometheus exposition syntax', () => {
    const body = formatPrometheusMetrics(snapshot)
    const valueLines = body
      .trim()
      .split('\n')
      .filter((line) => !line.startsWith('#'))
    assert.equal(valueLines.length, 10)
    for (const line of valueLines) {
      assert.match(line, /^cardinaljs_[a-z_]+ \d+$/)
    }
  })

  test('ends with a trailing newline, as the exposition format requires', () => {
    assert.ok(formatPrometheusMetrics(snapshot).endsWith('\n'))
  })
})
