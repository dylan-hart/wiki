import { defineStore } from 'pinia'

/**
 * Cross-component UI state for the knowledge graph view (OpenProject #3364).
 *
 * `selectedPath` is the raw path of the node the reader has SELECTED via a first canvas click
 * (`pages/Graph.vue#onCanvasClick`, OpenProject #3363's own click-once-select/click-twice-navigate
 * state), or `null` when nothing is selected. Read by the nav sidebar
 * (`composables/navSidebarDestination.js#isSelected`) to mirror the selection onto that row using
 * the sidebar's own "current row" style (`NavSidebar.vue`'s `.is-graph-selected` rule) -- the graph
 * CANVAS itself draws no selected-node treatment of its own; the styling belongs on the sidebar row,
 * the same surface `is-graph-anchor` already uses for the anchor.
 *
 * A bare path, not `Graph.vue`'s own `${locale}:${path}` composite node id: the sidebar tree is
 * scoped to one locale at a time (`pageStore.locale`) and already compares its own `item.path`
 * against exactly this raw form for the anchor (`isAnchor()`), so this mirrors that rather than
 * introducing a second identity scheme the sidebar would have to unpack.
 *
 * `Graph.vue` clears this in its own `onBeforeUnmount` so a selection never outlives the page that
 * set it -- there is nothing left to highlight in the sidebar once the reader has left `/_graph`.
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
