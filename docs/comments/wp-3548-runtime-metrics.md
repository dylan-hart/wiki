# WP 3548 — recommended comments (runtime gauges)

Not applied to the code, per the repo's comment rule. Each entry names where it would go.

## `backend/helpers/metrics.ts`

- Above `createRuntimeSampler`'s `const sampled = histogram.count > 0`:
  `// -> An empty histogram reports min = 2^63 and mean = NaN, which must never reach the exposition.`
- Above `EVENT_LOOP_WINDOW_HELP`: `monitorEventLoopDelay` samples are the timer's whole interval,
  not just the lateness, so an idle loop reads about the 10 ms resolution. Mirrored in the HELP text
  and `docs/operations.md`; change all together.
- Above `histogram.reset()`: the delay gauges cover the window since the previous scrape; two
  scrapers share one window.

## `backend/controllers/metrics.ts`

- Above the `onClose` hook: the histogram's timer must be disabled with the app, or a test that
  registers and closes this plugin leaves a live sampler behind.
- Above `runtimeSampler ??= createRuntimeSampler()`: normally created at registration; created lazily
  only when the plugin registered before `metrics.isEnabled` was true.
- The header comment's "there are no counters, histograms or registries" stays true: the event-loop
  histogram is an in-process Node `perf_hooks` object summarised to plain gauges, never exposed as a
  Prometheus histogram.
