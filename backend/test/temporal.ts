/**
 * Shared `Temporal` polyfill installer for backend test suites.
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import. This sandbox's Node (25.9)
 * lacks it natively, so any suite whose code under test touches `Temporal` (directly, or via
 * `Date.prototype.toTemporalInstant()`) needs it installed before that code runs. `ensureTemporal()`
 * feature-detects the gap and installs the real `@js-temporal/polyfill` package -- true Temporal
 * semantics, not a hand-rolled approximation -- so it is a no-op on a real Node 26 runtime and never
 * masks a production bug the way a loose fake could. Shape proven at `models/export.test.ts:28-34`.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    const polyfill = await import('@js-temporal/polyfill')
    ;(globalThis as any).Temporal = polyfill.Temporal
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      return polyfill.toTemporalInstant.call(this)
    }
  }
}
