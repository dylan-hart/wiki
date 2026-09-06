/**
 * The pure derivations behind the boot narrative's two composed lines — `boot ready`'s facts and a
 * worker thread's own instance id.
 *
 * Both are computed inside an entry point (`index.ts`, `worker.ts`) that runs its whole boot
 * sequence at import time and therefore cannot be imported by a test at all. Extracting the
 * derivation is what makes it testable, per this task's own note ("test the id derivation as a pure
 * function it imports"); the entry point keeps only the `WIKI.logger` call it feeds.
 */

/**
 * The one site shape `readyFields` reads. `WIKI.sites` values carry far more; none of it matters
 * here.
 */
export interface ReadySite {
  hostname?: string | null
}

export interface ReadyFieldsInput {
  /** `WIKI.sites` — keyed by site id, in the order `models/sites.ts#reloadCache` inserted them. */
  sites: Record<string, ReadySite>
  bindIP: string
  port: number | string
  /** Milliseconds elapsed since `WIKI.startedAt`. */
  ms: number
}

/**
 * A `type` rather than an `interface` on purpose: only a type alias gets TypeScript's implicit index
 * signature, which is what makes it assignable to `core/logger.ts`'s `LogFields`
 * (`Record<string, unknown>`) without a cast at the call site.
 */
export type ReadyFields = {
  sites: number
  url: string
  ms: number
}

/**
 * `sites=`, `url=` and `ms=` for the `boot ready` line.
 *
 * `url` is the first site hostname an operator could actually type. The default site's hostname is
 * the catch-all `*` (`models/sites.ts#init`), which is not an address, so a `*` entry is skipped in
 * favour of a later real one; an instance whose sites are all catch-alls falls back to the bound
 * socket instead. No scheme is prepended — whether this instance is reached over http or https is
 * decided by whatever terminates TLS in front of it (`docs/tls-termination.md`), which the process
 * itself does not know.
 */
export function readyFields({ sites, bindIP, port, ms }: ReadyFieldsInput): ReadyFields {
  const entries = Object.values(sites ?? {})
  const addressable = entries.find((site) => site?.hostname && site.hostname !== '*')
  return {
    sites: entries.length,
    url: addressable?.hostname ?? `${bindIP}:${port}`,
    ms
  }
}

/**
 * A worker thread's `INSTANCE_ID`: the parent instance's id, then the thread's ordinal.
 *
 * Both halves have to be known before the worker's logger is built, so neither can come from a job
 * payload — `worker.ts` used to boot as the literal `'worker'` and overwrite itself with the
 * parent's id on the first job, which filed every boot line it emitted under a different identity
 * than every job line that followed (audit N8). The parent id now arrives through poolifier's
 * `workerData` (`core/scheduler.ts`'s `poolOptions`) and the ordinal is the thread's own `threadId`,
 * since one `workerData` object is shared by every worker in the pool and so cannot carry a
 * per-worker index.
 *
 * A worker started outside a pool — nothing does today, but a bare `new Worker('worker.ts')` in a
 * test or a script would — has no parent to name and falls back to `worker`, which is what the id
 * used to be unconditionally.
 */
export function workerInstanceId(parentInstanceId: unknown, ordinal: number): string {
  const parent =
    typeof parentInstanceId === 'string' && parentInstanceId.length > 0
      ? parentInstanceId
      : 'worker'
  return `${parent}/w${ordinal}`
}
