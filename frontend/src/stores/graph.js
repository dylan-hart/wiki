import { defineStore } from 'pinia'

/**
 * Cross-component UI state for the knowledge graph view.
 *
 * A selected node is drawn by both the nav sidebar row and a ring on the graph canvas. Besides the
 * sidebar's in-graph clicks, `HeaderNav.vue#onGraphNavClick` sets it on entry (the viewed page).
 *
 * `selectedPath` is a bare path, not `Graph.vue`'s own `${locale}:${path}` composite node id: the
 * sidebar tree is scoped to one locale at a time and already compares its own `item.path` in this
 * raw form, so a second identity scheme would only have to be unpacked again.
 *
 * `Graph.vue` clears it on unmount -- there is nothing left to highlight once the reader has left
 * `/_graph`.
 */
export const useGraphStore = defineStore('graph', {
  state: () => ({
    selectedPath: null
  }),
  actions: {
    select(path) {
      this.selectedPath = path
    },
    clearSelection() {
      this.selectedPath = null
    }
  }
})
