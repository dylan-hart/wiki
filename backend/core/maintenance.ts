/**
 * The admin utilities view's maintenance actions. Both act on state that is an instance's own (its
 * websockets, its memory, its cache directory), so each is published on the event bus and every
 * instance runs the same function. The acknowledgement is local for the same reason: a route's
 * `count` is this instance's own, and there is no registry of instances to wait for answers from.
 */
export default {
  /**
   * Every websocket, whichever controller opened it. 1012 rather than the private 4000-range codes
   * the controllers refuse a session with: those tell a client not to try again, while an ordinary
   * drop lets an editor reconnect on its own and rejoin its room.
   */
  disconnectWebsockets(): number {
    let count = 0
    for (const client of CARDINAL.app.websocketServer.clients) {
      if (client.readyState !== client.OPEN) {
        continue
      }
      client.close(1012, 'Disconnected by an administrator')
      count++
    }
    CARDINAL.logger.info('cluster', 'closed websocket connections', { connections: count })
    return count
  },

  /**
   * Drops only what the database is the real copy of. The model caches that answer every request
   * are refilled before this returns rather than left for the next visitor to pay for.
   */
  async flushCaches(): Promise<void> {
    CARDINAL.cache.clear()
    await CARDINAL.models.assetServing.purgeCache()
    await CARDINAL.models.icons.purgeCache()

    await CARDINAL.models.locales.reloadCache()
    await CARDINAL.models.sites.reloadCache()
    await CARDINAL.models.groups.reloadCache()
    await CARDINAL.models.approvalRules.reloadCache()
    await CARDINAL.models.classificationLevels.reloadCache()

    CARDINAL.logger.info('cluster', 'flushed all caches')
  },

  subscribeToEvents(): void {
    CARDINAL.events.inbound.on('disconnectWebsockets', () => {
      this.disconnectWebsockets()
    })
    CARDINAL.events.inbound.on('flushCaches', async () => {
      await this.flushCaches()
    })
  }
}
