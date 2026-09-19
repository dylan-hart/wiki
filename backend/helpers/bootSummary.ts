/**
 * Pure derivations kept out of `index.ts` and `worker.ts`: both run their whole boot sequence at
 * import time, so a test cannot import them.
 */

export interface ReadySite {
  hostname?: string | null
}

export interface ReadyFieldsInput {
  /** `CARDINAL.sites`; insertion order decides which hostname `url` reports. */
  sites: Record<string, ReadySite>
  bindIP: string
  port: number | string
  ms: number
}

/**
 * A `type`, not an `interface`: only a type alias gets an implicit index signature, which is what
 * makes it assignable to `core/logger.ts`'s `LogFields` without a cast.
 */
export type ReadyFields = {
  sites: number
  url: string
  ms: number
}

/**
 * `url` is the first hostname an operator could actually type: the default site's catch-all `*` is
 * not an address, so it is skipped, and an instance with only catch-alls reports the bound socket.
 * No scheme is prepended — whatever terminates TLS in front of the process decides that, and the
 * process does not know.
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
 * Both halves must be known before the worker's logger is built, so neither can come from a job
 * payload: the parent id arrives through piscina's `workerData`, and the ordinal is the thread's
 * own `threadId`, since one `workerData` object is shared by the whole pool. A worker started
 * outside a pool has no parent and falls back to `worker`.
 */
export function workerInstanceId(parentInstanceId: unknown, ordinal: number): string {
  const parent =
    typeof parentInstanceId === 'string' && parentInstanceId.length > 0
      ? parentInstanceId
      : 'worker'
  return `${parent}/w${ordinal}`
}
