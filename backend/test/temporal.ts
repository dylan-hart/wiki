/**
 * Polyfill `Temporal` for a suite that touches it, when the runtime doesn't already provide it
 * natively.
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, so this is a no-op there —
 * it exists only for a dev sandbox whose `node` predates that (this repo's own test suites were
 * written against Node 25.9, which doesn't expose it; same environment gap noted in
 * `core/scheduler.test.ts` and tasks 753/756/757/760/761). `@js-temporal/polyfill` supplies the
 * `Temporal` global itself but, unlike Node 26, does not also patch `Date.prototype
 * .toTemporalInstant()` — several call sites (`purgeExpired()`, `apiKeys.ts`'s expiry/invalidation
 * checks, ...) rely on that conversion, so this patches it too.
 *
 * Shared home for the polyfill-install step every Temporal-touching suite used to hand-roll on its
 * own (`models/export.test.ts`, `modules/storage/disk/storage.test.ts`, and others) — `backend/test/`
 * is already the reserved home for shared fixture code, alongside `db.ts` and `mocks.ts`.
 *
 * Deliberately does not save or restore the previous `Temporal`/`toTemporalInstant` state: unlike a
 * hand-rolled fake standing in for the real thing, this installs the SAME polyfill Node 26 ships
 * natively, so leaving it in place for the rest of the process is harmless — there is nothing to
 * put back that differs from what this just installed.
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
