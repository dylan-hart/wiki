import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPrometheusMetrics, type MetricsSnapshot } from './metrics.ts'

const snapshot: MetricsSnapshot = {
  activeWorkers: 2,
  pagesTotal: 431,
  usersTotal: 17,
  groupsTotal: 4,
  instancesTotal: 3,
  jobsQueued: 0
}

describe('formatPrometheusMetrics', () => {
  test('writes one HELP/TYPE/value triplet per metric, in a stable order', () => {
    const body = formatPrometheusMetrics(snapshot)
    assert.equal(
      body,
      [
        '# HELP wikijs_active_workers Jobs currently executing, across every instance connected to this database.',
        '# TYPE wikijs_active_workers gauge',
        'wikijs_active_workers 2',
        '# HELP wikijs_pages_total Total number of pages.',
        '# TYPE wikijs_pages_total gauge',
        'wikijs_pages_total 431',
        '# HELP wikijs_users_total Total number of user accounts.',
        '# TYPE wikijs_users_total gauge',
        'wikijs_users_total 17',
        '# HELP wikijs_groups_total Total number of groups.',
        '# TYPE wikijs_groups_total gauge',
        'wikijs_groups_total 4',
        '# HELP wikijs_instances_total Instances currently connected to this database.',
        '# TYPE wikijs_instances_total gauge',
        'wikijs_instances_total 3',
        '# HELP wikijs_jobs_queued Jobs waiting in the queue, not yet claimed by a worker.',
        '# TYPE wikijs_jobs_queued gauge',
        'wikijs_jobs_queued 0',
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
    assert.equal(valueLines.length, 6)
    for (const line of valueLines) {
      assert.match(line, /^wikijs_[a-z_]+ \d+$/)
    }
  })

  test('ends with a trailing newline, as the exposition format requires', () => {
    assert.ok(formatPrometheusMetrics(snapshot).endsWith('\n'))
  })
})
