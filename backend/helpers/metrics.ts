/**
 * The gauge values `/metrics` reports, sourced from data already computed for `GET
 * /_api/system/info` and `WIKI.models.jobs` — this module invents no new data path, only a text
 * rendering of numbers those already compute.
 */
export interface MetricsSnapshot {
  activeWorkers: number
  pagesTotal: number
  usersTotal: number
  groupsTotal: number
  instancesTotal: number
  jobsQueued: number
}

/** One gauge's Prometheus name and help text, in the order they are written to the response. */
const METRIC_DEFS: { key: keyof MetricsSnapshot; name: string; help: string }[] = [
  {
    key: 'activeWorkers',
    name: 'wikijs_active_workers',
    help: 'Jobs currently executing, across every instance connected to this database.'
  },
  {
    key: 'pagesTotal',
    name: 'wikijs_pages_total',
    help: 'Total number of pages.'
  },
  {
    key: 'usersTotal',
    name: 'wikijs_users_total',
    help: 'Total number of user accounts.'
  },
  {
    key: 'groupsTotal',
    name: 'wikijs_groups_total',
    help: 'Total number of groups.'
  },
  {
    key: 'instancesTotal',
    name: 'wikijs_instances_total',
    help: 'Instances currently connected to this database.'
  },
  {
    key: 'jobsQueued',
    name: 'wikijs_jobs_queued',
    help: 'Jobs waiting in the queue, not yet claimed by a worker.'
  }
]

/**
 * Render a metrics snapshot as Prometheus text exposition format (version 0.0.4).
 *
 * Hand-rolled rather than pulled in via `prom-client`: the metric set is six gauges computed
 * elsewhere, with no counters, histograms or per-request registry to justify a client library's
 * bookkeeping — see the `/metrics` scope decision in `controllers/metrics.ts` for the full call.
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
