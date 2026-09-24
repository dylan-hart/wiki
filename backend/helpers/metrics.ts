import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { NOTIFY_DURATION_BUCKETS, type NotifierStats } from './pubsub.ts'

export interface MetricsSnapshot {
  activeWorkers: number
  pagesTotal: number
  usersTotal: number
  groupsTotal: number
  instancesTotal: number
  jobsQueued: number
  /** Currently retained in job history — not a lifetime total. */
  jobsFailed: number
  dbPoolTotal: number
  dbPoolIdle: number
  dbPoolWaiting: number
}

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
 * Prometheus text exposition format (version 0.0.4), hand-rolled rather than via `prom-client`: the
 * series are few and fixed, and the only per-event state (`helpers/pubsub.ts#notifierStats`) is a
 * handful of plain numbers per notifier, too little to justify a client library's registry.
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

export interface RuntimeSnapshot {
  residentMemoryBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalMemoryBytes: number
  uptimeSeconds: number
  cpuUserSeconds: number
  cpuSystemSeconds: number
  eventLoopDelayMinSeconds: number
  eventLoopDelayMeanSeconds: number
  eventLoopDelayMaxSeconds: number
  eventLoopDelayP50Seconds: number
  eventLoopDelayP99Seconds: number
}

const EVENT_LOOP_WINDOW_HELP =
  ' Sampled every 10 ms and includes that sampling interval, over the window since the previous scrape.'

const RUNTIME_METRIC_DEFS: { key: keyof RuntimeSnapshot; name: string; help: string }[] = [
  {
    key: 'residentMemoryBytes',
    name: 'cardinaljs_process_resident_memory_bytes',
    help: 'Resident set size of the Node process, in bytes.'
  },
  {
    key: 'heapUsedBytes',
    name: 'cardinaljs_process_heap_used_bytes',
    help: 'V8 heap in use, in bytes.'
  },
  {
    key: 'heapTotalBytes',
    name: 'cardinaljs_process_heap_total_bytes',
    help: 'V8 heap allocated, in bytes.'
  },
  {
    key: 'externalMemoryBytes',
    name: 'cardinaljs_process_external_memory_bytes',
    help: 'Memory used by C++ objects bound to JavaScript objects managed by V8, in bytes.'
  },
  {
    key: 'uptimeSeconds',
    name: 'cardinaljs_process_uptime_seconds',
    help: 'Seconds the Node process has been running.'
  },
  {
    key: 'cpuUserSeconds',
    name: 'cardinaljs_process_cpu_user_seconds_total',
    help: 'Cumulative user CPU time of the Node process, in seconds.'
  },
  {
    key: 'cpuSystemSeconds',
    name: 'cardinaljs_process_cpu_system_seconds_total',
    help: 'Cumulative system CPU time of the Node process, in seconds.'
  },
  {
    key: 'eventLoopDelayMinSeconds',
    name: 'cardinaljs_nodejs_eventloop_delay_min_seconds',
    help: 'Minimum event loop delay, in seconds.' + EVENT_LOOP_WINDOW_HELP
  },
  {
    key: 'eventLoopDelayMeanSeconds',
    name: 'cardinaljs_nodejs_eventloop_delay_mean_seconds',
    help: 'Mean event loop delay, in seconds.' + EVENT_LOOP_WINDOW_HELP
  },
  {
    key: 'eventLoopDelayMaxSeconds',
    name: 'cardinaljs_nodejs_eventloop_delay_max_seconds',
    help: 'Maximum event loop delay, in seconds.' + EVENT_LOOP_WINDOW_HELP
  },
  {
    key: 'eventLoopDelayP50Seconds',
    name: 'cardinaljs_nodejs_eventloop_delay_p50_seconds',
    help: 'Median event loop delay, in seconds.' + EVENT_LOOP_WINDOW_HELP
  },
  {
    key: 'eventLoopDelayP99Seconds',
    name: 'cardinaljs_nodejs_eventloop_delay_p99_seconds',
    help: '99th percentile event loop delay, in seconds.' + EVENT_LOOP_WINDOW_HELP
  }
]

export function formatRuntimeMetrics(snapshot: RuntimeSnapshot): string {
  const lines: string[] = []
  for (const { key, name, help } of RUNTIME_METRIC_DEFS) {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} gauge`)
    lines.push(`${name} ${snapshot[key]}`)
  }
  return lines.join('\n') + '\n'
}

export interface RuntimeSamplerDeps {
  memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapTotal' | 'heapUsed' | 'external'>
  cpuUsage: () => NodeJS.CpuUsage
  uptime: () => number
  histogram: Pick<
    IntervalHistogram,
    'enable' | 'disable' | 'reset' | 'count' | 'min' | 'mean' | 'max' | 'percentile'
  >
}

const NANOSECONDS_PER_SECOND = 1e9
const MICROSECONDS_PER_SECOND = 1e6

export function createRuntimeSampler(deps?: Partial<RuntimeSamplerDeps>) {
  const memoryUsage = deps?.memoryUsage ?? (() => process.memoryUsage())
  const cpuUsage = deps?.cpuUsage ?? (() => process.cpuUsage())
  const uptime = deps?.uptime ?? (() => process.uptime())
  const histogram = deps?.histogram ?? monitorEventLoopDelay({ resolution: 10 })
  let running = true
  histogram.enable()

  return {
    collect(): RuntimeSnapshot {
      const memory = memoryUsage()
      const cpu = cpuUsage()
      // -> An empty histogram reports min = 2^63 and mean = NaN, which must never reach the exposition
      const sampled = histogram.count > 0
      const seconds = (nanoseconds: number) => (sampled ? nanoseconds / NANOSECONDS_PER_SECOND : 0)
      const snapshot: RuntimeSnapshot = {
        residentMemoryBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalMemoryBytes: memory.external,
        uptimeSeconds: uptime(),
        cpuUserSeconds: cpu.user / MICROSECONDS_PER_SECOND,
        cpuSystemSeconds: cpu.system / MICROSECONDS_PER_SECOND,
        eventLoopDelayMinSeconds: seconds(histogram.min),
        eventLoopDelayMeanSeconds: seconds(histogram.mean),
        eventLoopDelayMaxSeconds: seconds(histogram.max),
        eventLoopDelayP50Seconds: seconds(histogram.percentile(50)),
        eventLoopDelayP99Seconds: seconds(histogram.percentile(99))
      }
      histogram.reset()
      return snapshot
    },
    stop(): void {
      if (!running) return
      running = false
      histogram.disable()
    }
  }
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function labelSet(labels: Record<string, string>): string {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
  return `{${pairs.join(',')}}`
}

const PUBSUB_SENT = 'cardinaljs_pubsub_notify_sent_total'
const PUBSUB_DROPPED = 'cardinaljs_pubsub_notify_dropped_total'
const PUBSUB_QUEUE_DEPTH = 'cardinaljs_pubsub_notify_queue_depth'
const PUBSUB_DURATION = 'cardinaljs_pubsub_notify_duration_seconds'

export function formatPubsubMetrics(stats: readonly NotifierStats[]): string {
  const lines: string[] = []

  lines.push(
    `# HELP ${PUBSUB_SENT} Postgres NOTIFYs this instance has sent, per notifier.`,
    `# TYPE ${PUBSUB_SENT} counter`
  )
  for (const s of stats) {
    lines.push(`${PUBSUB_SENT}${labelSet({ channel: s.channel })} ${s.sent}`)
  }

  lines.push(
    `# HELP ${PUBSUB_DROPPED} NOTIFYs discarded without being sent: reason "error" when pg_notify ` +
      'failed, "no_client" when the notifier had no open listener connection, "no_peer" when no ' +
      'other instance was known to be running to receive it.',
    `# TYPE ${PUBSUB_DROPPED} counter`
  )
  for (const s of stats) {
    for (const [reason, value] of [
      ['error', s.droppedError],
      ['no_client', s.droppedNoClient],
      ['no_peer', s.droppedNoPeer]
    ] as const) {
      lines.push(`${PUBSUB_DROPPED}${labelSet({ channel: s.channel, reason })} ${value}`)
    }
  }

  lines.push(
    `# HELP ${PUBSUB_QUEUE_DEPTH} NOTIFYs queued on this instance's serial notifier, including the ` +
      'one in flight. A depth that keeps growing means the notifier cannot keep up.',
    `# TYPE ${PUBSUB_QUEUE_DEPTH} gauge`
  )
  for (const s of stats) {
    lines.push(`${PUBSUB_QUEUE_DEPTH}${labelSet({ channel: s.channel })} ${s.queueDepth}`)
  }

  lines.push(
    `# HELP ${PUBSUB_DURATION} Round-trip time of a successful pg_notify, in seconds, excluding ` +
      'time spent queued behind earlier NOTIFYs.',
    `# TYPE ${PUBSUB_DURATION} histogram`
  )
  for (const s of stats) {
    NOTIFY_DURATION_BUCKETS.forEach((le, i) => {
      const labels = labelSet({ channel: s.channel, le: String(le) })
      lines.push(`${PUBSUB_DURATION}_bucket${labels} ${s.durationBuckets[i]}`)
    })
    lines.push(
      `${PUBSUB_DURATION}_bucket${labelSet({ channel: s.channel, le: '+Inf' })} ${s.durationCount}`
    )
    lines.push(`${PUBSUB_DURATION}_sum${labelSet({ channel: s.channel })} ${s.durationSum}`)
    lines.push(`${PUBSUB_DURATION}_count${labelSet({ channel: s.channel })} ${s.durationCount}`)
  }

  return lines.join('\n') + '\n'
}
