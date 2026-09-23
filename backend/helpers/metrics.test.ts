import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createRuntimeSampler,
  formatPubsubMetrics,
  formatRuntimeMetrics,
  type RuntimeSnapshot,
  type RuntimeSamplerDeps
} from './metrics.ts'
import { NOTIFY_DURATION_BUCKETS, type NotifierStats } from './pubsub.ts'

function fakeHistogram(values: {
  count: number
  min: number
  mean: number
  max: number
  p50: number
  p99: number
}) {
  const calls: string[] = []
  const histogram: RuntimeSamplerDeps['histogram'] = {
    enable: () => {
      calls.push('enable')
      return true
    },
    disable: () => {
      calls.push('disable')
      return true
    },
    reset: () => {
      calls.push('reset')
    },
    count: values.count,
    min: values.min,
    mean: values.mean,
    max: values.max,
    percentile: (p: number) => (p === 50 ? values.p50 : values.p99)
  }
  return { calls, histogram }
}

const deps = (histogram: RuntimeSamplerDeps['histogram']): RuntimeSamplerDeps => ({
  memoryUsage: () => ({ rss: 100, heapTotal: 50, heapUsed: 40, external: 7 }),
  cpuUsage: () => ({ user: 2_500_000, system: 500_000 }),
  uptime: () => 12.5,
  histogram
})

describe('createRuntimeSampler', () => {
  test('converts memory, cpu (microseconds) and event-loop delay (nanoseconds) to base units', () => {
    const { histogram } = fakeHistogram({
      count: 10,
      min: 10_000_000,
      mean: 12_000_000,
      max: 30_000_000,
      p50: 11_000_000,
      p99: 25_000_000
    })
    const snapshot = createRuntimeSampler(deps(histogram)).collect()

    assert.deepEqual(snapshot, {
      residentMemoryBytes: 100,
      heapUsedBytes: 40,
      heapTotalBytes: 50,
      externalMemoryBytes: 7,
      uptimeSeconds: 12.5,
      cpuUserSeconds: 2.5,
      cpuSystemSeconds: 0.5,
      eventLoopDelayMinSeconds: 0.01,
      eventLoopDelayMeanSeconds: 0.012,
      eventLoopDelayMaxSeconds: 0.03,
      eventLoopDelayP50Seconds: 0.011,
      eventLoopDelayP99Seconds: 0.025
    })
  })

  test('reports zeros, not the empty histogram sentinels, before any delay is sampled', () => {
    const { histogram } = fakeHistogram({
      count: 0,
      min: 9223372036854776000,
      mean: NaN,
      max: 0,
      p50: 0,
      p99: 0
    })
    const snapshot = createRuntimeSampler(deps(histogram)).collect()

    assert.equal(snapshot.eventLoopDelayMinSeconds, 0)
    assert.equal(snapshot.eventLoopDelayMeanSeconds, 0)
    assert.equal(snapshot.eventLoopDelayMaxSeconds, 0)
    assert.equal(snapshot.eventLoopDelayP50Seconds, 0)
    assert.equal(snapshot.eventLoopDelayP99Seconds, 0)
  })

  test('enables on creation, resets after each collect and disables once on stop', () => {
    const { histogram, calls } = fakeHistogram({
      count: 1,
      min: 1,
      mean: 1,
      max: 1,
      p50: 1,
      p99: 1
    })
    const sampler = createRuntimeSampler(deps(histogram))
    assert.deepEqual(calls, ['enable'])

    sampler.collect()
    sampler.collect()
    assert.deepEqual(calls, ['enable', 'reset', 'reset'])

    sampler.stop()
    sampler.stop()
    assert.deepEqual(calls, ['enable', 'reset', 'reset', 'disable'])
  })

  test('the real sampler yields finite, non-negative values and stops cleanly', () => {
    const sampler = createRuntimeSampler()
    try {
      const snapshot = sampler.collect()
      for (const [key, value] of Object.entries(snapshot)) {
        assert.ok(Number.isFinite(value) && value >= 0, `${key} = ${value}`)
      }
      assert.ok(snapshot.residentMemoryBytes > 0)
      assert.ok(snapshot.heapUsedBytes <= snapshot.heapTotalBytes)
    } finally {
      sampler.stop()
    }
  })
})

describe('formatRuntimeMetrics', () => {
  const snapshot: RuntimeSnapshot = {
    residentMemoryBytes: 100,
    heapUsedBytes: 40,
    heapTotalBytes: 50,
    externalMemoryBytes: 7,
    uptimeSeconds: 12.5,
    cpuUserSeconds: 2.5,
    cpuSystemSeconds: 0.5,
    eventLoopDelayMinSeconds: 0.01,
    eventLoopDelayMeanSeconds: 0.012,
    eventLoopDelayMaxSeconds: 0.03,
    eventLoopDelayP50Seconds: 0.011,
    eventLoopDelayP99Seconds: 0.025
  }

  test('renders one HELP/TYPE/sample triple per series, all gauges', () => {
    const text = formatRuntimeMetrics(snapshot)
    const lines = text.trimEnd().split('\n')

    assert.ok(text.endsWith('\n'))
    assert.equal(lines.length, 12 * 3)
    assert.ok(lines.filter((l) => l.startsWith('# TYPE ')).every((l) => l.endsWith(' gauge')))
    assert.deepEqual(
      lines.filter((l) => !l.startsWith('#')),
      [
        'cardinaljs_process_resident_memory_bytes 100',
        'cardinaljs_process_heap_used_bytes 40',
        'cardinaljs_process_heap_total_bytes 50',
        'cardinaljs_process_external_memory_bytes 7',
        'cardinaljs_process_uptime_seconds 12.5',
        'cardinaljs_process_cpu_user_seconds_total 2.5',
        'cardinaljs_process_cpu_system_seconds_total 0.5',
        'cardinaljs_nodejs_eventloop_delay_min_seconds 0.01',
        'cardinaljs_nodejs_eventloop_delay_mean_seconds 0.012',
        'cardinaljs_nodejs_eventloop_delay_max_seconds 0.03',
        'cardinaljs_nodejs_eventloop_delay_p50_seconds 0.011',
        'cardinaljs_nodejs_eventloop_delay_p99_seconds 0.025'
      ]
    )
  })
})

describe('formatPubsubMetrics', () => {
  function stats(channel: string, overrides: Partial<NotifierStats> = {}): NotifierStats {
    return {
      channel,
      sent: 0,
      droppedError: 0,
      droppedNoClient: 0,
      queueDepth: 0,
      durationBuckets: NOTIFY_DURATION_BUCKETS.map(() => 0),
      durationSum: 0,
      durationCount: 0,
      ...overrides
    }
  }

  test('renders counters, the queue-depth gauge and the duration histogram per channel label', () => {
    const text = formatPubsubMetrics([
      stats('collaboration relay', {
        sent: 42,
        droppedError: 1,
        droppedNoClient: 2,
        queueDepth: 3,
        durationBuckets: [0, 0, 1, 5, 10, 10, 10, 10, 10, 10, 10],
        durationSum: 0.125,
        durationCount: 10
      }),
      stats('event bus', { sent: 7 })
    ])

    assert.ok(text.endsWith('\n'))
    const lines = text.trimEnd().split('\n')

    assert.ok(lines.includes('# TYPE cardinaljs_pubsub_notify_sent_total counter'))
    assert.ok(lines.includes('# TYPE cardinaljs_pubsub_notify_dropped_total counter'))
    assert.ok(lines.includes('# TYPE cardinaljs_pubsub_notify_queue_depth gauge'))
    assert.ok(lines.includes('# TYPE cardinaljs_pubsub_notify_duration_seconds histogram'))

    const relay = 'channel="collaboration relay"'
    const bus = 'channel="event bus"'
    const bucket = 'cardinaljs_pubsub_notify_duration_seconds_bucket'
    const samples = lines.filter((l) => !l.startsWith('#'))
    assert.deepEqual(samples, [
      `cardinaljs_pubsub_notify_sent_total{${relay}} 42`,
      `cardinaljs_pubsub_notify_sent_total{${bus}} 7`,
      `cardinaljs_pubsub_notify_dropped_total{${relay},reason="error"} 1`,
      `cardinaljs_pubsub_notify_dropped_total{${relay},reason="no_client"} 2`,
      `cardinaljs_pubsub_notify_dropped_total{${bus},reason="error"} 0`,
      `cardinaljs_pubsub_notify_dropped_total{${bus},reason="no_client"} 0`,
      `cardinaljs_pubsub_notify_queue_depth{${relay}} 3`,
      `cardinaljs_pubsub_notify_queue_depth{${bus}} 0`,
      `${bucket}{${relay},le="0.001"} 0`,
      `${bucket}{${relay},le="0.0025"} 0`,
      `${bucket}{${relay},le="0.005"} 1`,
      `${bucket}{${relay},le="0.01"} 5`,
      `${bucket}{${relay},le="0.025"} 10`,
      `${bucket}{${relay},le="0.05"} 10`,
      `${bucket}{${relay},le="0.1"} 10`,
      `${bucket}{${relay},le="0.25"} 10`,
      `${bucket}{${relay},le="0.5"} 10`,
      `${bucket}{${relay},le="1"} 10`,
      `${bucket}{${relay},le="2.5"} 10`,
      `${bucket}{${relay},le="+Inf"} 10`,
      `cardinaljs_pubsub_notify_duration_seconds_sum{${relay}} 0.125`,
      `cardinaljs_pubsub_notify_duration_seconds_count{${relay}} 10`,
      ...NOTIFY_DURATION_BUCKETS.map((le) => `${bucket}{${bus},le="${le}"} 0`),
      `${bucket}{${bus},le="+Inf"} 0`,
      `cardinaljs_pubsub_notify_duration_seconds_sum{${bus}} 0`,
      `cardinaljs_pubsub_notify_duration_seconds_count{${bus}} 0`
    ])
  })

  test('escapes backslashes, double quotes and newlines in a label value', () => {
    const text = formatPubsubMetrics([stats('a\\b"c\nd', { sent: 1 })])
    assert.ok(
      text.includes('cardinaljs_pubsub_notify_sent_total{channel="a\\\\b\\"c\\nd"} 1\n'),
      text
    )
  })

  test('with no notifier registered, still declares every family but emits no samples', () => {
    const lines = formatPubsubMetrics([]).trimEnd().split('\n')
    assert.equal(lines.length, 8)
    assert.ok(lines.every((l) => l.startsWith('# HELP ') || l.startsWith('# TYPE ')))
  })
})
