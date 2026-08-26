/**
 * Shared `Temporal` availability shim for backend tests.
 *
 * This sandbox's `node` is v25.9.0, which has no native `Temporal` global (the repo's engine floor
 * is Node 26 — see CLAUDE.md). `ensureTemporal()` feature-detects that gap and, only when missing,
 * dynamically imports `@js-temporal/polyfill` and installs both `globalThis.Temporal` and
 * `Date.prototype.toTemporalInstant` — real polyfill semantics, not a hand-rolled fake, so calendar-
 * aware arithmetic (leap years, `Instant.compare`, `smallestUnit` string options, …) behaves exactly
 * as it will under a real Node 26 runtime. On Node 26 itself this is a no-op.
 *
 * Reference shape: `backend/models/export.test.ts`'s own inline `before()` check, extracted here so
 * new and converted suites call one shared helper instead of repeating (or, worse, loosely
 * re-approximating) the same few lines.
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
