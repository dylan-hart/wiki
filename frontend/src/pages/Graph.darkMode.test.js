import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDark } from '@/composables/dark'
import { mountGraph } from './graphFixtures.js'

/**
 * OpenProject #2412: Graph.vue's canvas had no dark-mode color swap at all -- `CATEGORICAL_PALETTE`
 * was a single light-surface array, and `colorForGroup()`'s cache stored the resolved hex, so even
 * adding a dark palette naively would have frozen every group at whichever mode first assigned it.
 * These assert the fix at the level a unit test actually can: the light/dark palettes are disjoint,
 * `colorForGroup()` picks the live mode's column, `recomputeClusters()` re-derives already-assigned
 * node colors from the new column rather than leaving them stuck, and the `dark.isActive` watcher
 * actually calls it on a toggle with no other trigger. Canvas pixel output itself isn't practically
 * assertable (`Graph.rendering.test.js`'s own documented limitation) -- see `graphDraw.test.js` for
 * the drawEdges()/drawLabels() stroke/fill-string coverage, and note real node colors here come
 * from an explicit `recomputeClusters()` call rather than a d3-force simulation tick, which under
 * test runs on its own async timer this suite doesn't drive.
 *
 * The `dark.isActive`-driven watch job (Graph.vue's `watch(() => dark.isActive, …)`) was observed
 * under this suite's `happy-dom` environment to sometimes land a turn of the event loop later than
 * a plain `await nextTick()` (even chained) reliably captures, especially with several `Graph.vue`
 * instances mounted across sibling test files in the same run and all sharing the one module-level
 * `dark.isActive` source. `vi.waitFor()` -- poll-until-true rather than a guessed tick count -- is
 * what actually made the wait deterministic; this is a test-environment timing quirk, not evidence
 * of anything wrong with the watcher itself (its wiring is covered directly, synchronously, by the
 * `colorForGroup()`/`recomputeClusters()` tests below).
 */
afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
})

describe('Graph.vue dark mode (OpenProject #2412)', () => {
  // -> colorForGroup() reads `dark.isActive` synchronously at call time -- it has no dependency on
  //    the watcher's async job, so this needs no waiting at all, unlike the node/cluster-repaint
  //    cases below (which go through `recomputeClusters()`, called either directly or by the
  //    watcher).
  it('colorForGroup() returns a color from the dark palette once dark mode is active, and from the light palette otherwise', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()

    dark.set(false)
    const lightColor = wrapper.vm.colorForGroup('')
    expect(wrapper.vm.CATEGORICAL_PALETTE_LIGHT).toContain(lightColor)
    expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).not.toContain(lightColor)

    dark.set(true)
    const darkColor = wrapper.vm.colorForGroup('')
    expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(darkColor)
    expect(darkColor).not.toBe(lightColor)
  })

  it('recomputeClusters() re-colors already-assigned node/cluster colors to the new palette, not just newly-seen groups', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()
    const realNodes = () => wrapper.vm.nodes.filter((node) => !node.synthetic)

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const lightColors = realNodes().map((node) => node.color)
    expect(lightColors.length).toBeGreaterThan(0)
    for (const color of lightColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_LIGHT).toContain(color)
    }

    dark.set(true)
    wrapper.vm.recomputeClusters()
    const darkColors = realNodes().map((node) => node.color)
    expect(darkColors).not.toEqual(lightColors)
    for (const color of darkColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(color)
    }
  })

  it('toggling dark.isActive alone (no manual recompute) repaints node colors via the watcher', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()
    const realNodes = () => wrapper.vm.nodes.filter((node) => !node.synthetic)

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const lightColors = realNodes().map((node) => node.color)

    // -> No explicit recomputeClusters()/repaint() call here -- only the mode flip, same as a
    //    reader actually toggling the app's theme switch while this page is open. `vi.waitFor()`
    //    polls until the watcher's own async job has actually run (see the suite-level doc comment
    //    on why a fixed tick count isn't reliable here).
    dark.set(true)
    await vi.waitFor(() => {
      expect(realNodes().map((node) => node.color)).not.toEqual(lightColors)
    })

    const darkColors = realNodes().map((node) => node.color)
    for (const color of darkColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(color)
    }
  })

  it('leaves the fixed synthetic-node color untouched by the mode toggle', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const syntheticNode = wrapper.vm.nodes.find((node) => node.synthetic)
    expect(syntheticNode?.color).toBe(wrapper.vm.SYNTHETIC_NODE_COLOR)

    dark.set(true)
    wrapper.vm.recomputeClusters()
    expect(syntheticNode.color).toBe(wrapper.vm.SYNTHETIC_NODE_COLOR)
  })
})
