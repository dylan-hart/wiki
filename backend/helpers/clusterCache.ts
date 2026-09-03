/**
 * The cross-instance reload protocol every whole-cache model shares.
 *
 * Five models (`groups`, `sites`, `approvals`, `classificationLevels`, `locales`) each keep a
 * process-local cache of a table they read on nearly every request, and each had written out the
 * same three-method trio to keep that cache honest across a cluster: `reloadCache()` (the only part
 * that actually differs), plus a `broadcastReload()` and a `subscribeToEvents()` that were literally
 * the same two lines under a different event-name string. This class owns those two, so the rule
 * they encode is written down once instead of five times.
 *
 * The rule: **`broadcastReload()` is what a mutator calls; `reloadCache()` is not.** By the time a
 * caller reaches here the write has already landed in the database — what is left is making every
 * instance's in-memory copy agree with it, this one included. And the inverse: **never emit the
 * reload event from inside `reloadCache()`**, because `reloadCache()` also runs when this class's
 * own inbound handler answers *another* instance's event, and broadcasting from there would echo the
 * event back around the cluster forever.
 *
 * `broadcastReload()` is public on every subclass. That is a widening for three of the five (their
 * copies were `private`), and harmless: a write that bypasses a model's own mutators — the raw
 * `onConflictDoUpdate` upsert `models/siteImport.ts#importSite` does for imported groups is the case
 * today — still needs this reload-then-notify shape, called by whoever performed the write
 * (`tasks/simple/import-content.ts`, `tasks/simple/update-locales.ts`).
 */
export abstract class ClusterReloaded {
  /**
   * The HA propagation event this model's cache travels on, e.g. `reloadGroups`. Declared by each
   * subclass; both methods below are written against it, so nothing else names the string.
   */
  protected abstract readonly reloadEvent: string

  /**
   * Rebuild this instance's cache from the database. Called at boot, by `broadcastReload()` (this
   * instance's own change) and by the inbound handler `subscribeToEvents()` registers (another
   * instance's change).
   */
  abstract reloadCache(): Promise<void>

  /** Reload this instance's own cache, then tell every other instance in the cluster to do the same. */
  async broadcastReload(): Promise<void> {
    await this.reloadCache()
    WIKI.events.outbound.emit(this.reloadEvent)
  }

  /** Subscribe to HA propagation events. */
  subscribeToEvents(): void {
    WIKI.events.inbound.on(this.reloadEvent, async () => {
      await this.reloadCache()
    })
  }
}
