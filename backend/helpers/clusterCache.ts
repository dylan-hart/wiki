/**
 * The cross-instance reload protocol for a model that caches a whole table in process memory.
 *
 * A mutator calls `broadcastReload()`, never `reloadCache()` directly: the write has landed, and
 * every instance's copy — this one included — has to agree with it. `reloadCache()` must never emit
 * the reload event itself: it also runs when the inbound handler answers another instance's event,
 * and emitting from there would echo around the cluster forever.
 *
 * `broadcastReload()` is public because a write that bypasses a model's own mutators (a raw upsert
 * during an import) still needs this reload-then-notify, called by whoever performed the write.
 */
export abstract class ClusterReloaded {
  /** The HA propagation event this model's cache travels on, e.g. `reloadGroups`. */
  protected abstract readonly reloadEvent: string

  abstract reloadCache(): Promise<void>

  async broadcastReload(): Promise<void> {
    await this.reloadCache()
    CARDINAL.events.outbound.emit(this.reloadEvent)
  }

  subscribeToEvents(): void {
    CARDINAL.events.inbound.on(this.reloadEvent, async () => {
      await this.reloadCache()
    })
  }
}
