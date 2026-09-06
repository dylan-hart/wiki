/**
 * The gauge values `/metrics` reports, sourced from data already computed for `GET
 * /_api/system/info`, `WIKI.models.jobs`, and (for the pool fields) `WIKI.dbManager.pool` — this
 * module invents no new data path, only a text rendering of numbers those already compute.
 */
export interface MetricsSnapshot {
  activeWorkers: number
  pagesTotal: number
  usersTotal: number
  groupsTotal: number
  instancesTotal: number
  jobsQueued: number
  /** Failed jobs currently retained in job history — not a lifetime total, see `METRIC_DEFS` help text. */
  jobsFailed: number
  /** Total clients (idle + in use) in the database connection pool. */
  dbPoolTotal: number
  /** Idle clients in the database connection pool, available to be checked out. */
  dbPoolIdle: number
  /** Queries currently waiting for a client to become available. */
  dbPoolWaiting: number
}

/** One gauge's Prometheus name and help text, in the order they are written to the response. */
const METRIC_DEFS: { key: keyof MetricsSnapshot; name: string; help: string }[] = [
  {
    key: 'activeWorkers',
    name: 'cardinaljs_active_workers',
    help: 'Jobs currently executing, across every instance connected to this database.'
  },
  {
    key: 'pagesTotal',
    name: 'cardinaljs_pages_total',
    help: 'Total number of pages.'
  },
  {
    key: 'usersTotal',
    name: 'cardinaljs_users_total',
    help: 'Total number of user accounts.'
  },
  {
    key: 'groupsTotal',
    name: 'cardinaljs_groups_total',
    help: 'Total number of groups.'
  },
  {
    key: 'instancesTotal',
    name: 'cardinaljs_instances_total',
    help: 'Instances currently connected to this database.'
  },
  {
    key: 'jobsQueued',
    name: 'cardinaljs_jobs_queued',
    help: 'Jobs waiting in the queue, not yet claimed by a worker.'
  },
  {
    key: 'jobsFailed',
    name: 'cardinaljs_jobs_failed_total',
    help:
      'Failed jobs currently retained in job history. Not a lifetime total: rows age out under the ' +
      'configured job history retention window, so this can decrease as well as increase between scrapes.'
  },
  {
    key: 'dbPoolTotal',
    name: 'cardinaljs_db_pool_total',
    help: 'Total clients (idle + in use) in the database connection pool.'
  },
  {
    key: 'dbPoolIdle',
    name: 'cardinaljs_db_pool_idle',
    help: 'Idle clients in the database connection pool, available to be checked out.'
  },
  {
    key: 'dbPoolWaiting',
    name: 'cardinaljs_db_pool_waiting',
    help: 'Queries currently waiting for a client to become available in the database connection pool.'
  }
]

/**
 * Render a metrics snapshot as Prometheus text exposition format (version 0.0.4).
 *
 * Hand-rolled rather than pulled in via `prom-client`: the metric set is ten gauges computed
 * elsewhere, with no counters, histograms or per-request registry to justify a client library's
 * bookkeeping — see the `/metrics` scope decision in `controllers/metrics.ts` for the full call
 * (task 594, revisited and reaffirmed at task 1939).
 */
export function formatPrometheusMetrics(snapshot: MetricsSnapshot): string {
  const lines: string[] = []
  for (const { key, name, help } of METRIC_DEFS) {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} gauge`)
    lines.push(`${name} ${snapshot[key]}`)
  }
  return lines.join('\n') + '\n'
}
