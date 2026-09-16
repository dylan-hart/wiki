import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/**
 * OpenProject #3354 (Feature #3338's "2 additional levels" scope): `Graph.vue`'s own
 * `folderLevelKeyFor()` and its wiring into `computeClusters()`/`startSimulation()`'s cluster force,
 * driven through the real mounted component rather than the pure-function suites
 * (`graphSimulation.test.js`/`graphForces.test.js` cover those in isolation). Mirrors
 * `Graph.layout.test.js`'s own "mutate a node's fields, call `computeClusters()`, read
 * `wrapper.vm.clusters`" pattern.
 */
describe('Graph.vue nested folder grouping circles (OpenProject #3354)', () => {
  it('a page 3 directory segments deep renders 3 nested circles: outer colored, inner two neutral', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> Only one node matters for this assertion; B is pushed out of A's own folder/level-2/level-3
    //    groups entirely so it can't accidentally join any of A's three circles.
    nodeA.path = 'docs/guides/setup/page'
    nodeA.folder = 'docs'
    nodeA.x = 0
    nodeA.y = 0
    nodeB.path = 'elsewhere'
    nodeB.folder = ''
    nodeB.x = 900
    nodeB.y = 900

    wrapper.vm.computeClusters()

    const outer = wrapper.vm.clusters.find((c) => c.key === 'docs' && c.level === undefined)
    const level2 = wrapper.vm.clusters.find((c) => c.level === 2)
    const level3 = wrapper.vm.clusters.find((c) => c.level === 3)
    expect(outer).toBeDefined()
    expect(level2).toBeDefined()
    expect(level2.key).toBe('docs/guides')
    expect(level3).toBeDefined()
    expect(level3.key).toBe('docs/guides/setup')

    // -> Only the outermost level keeps categorical color-coding; both nested levels share one
    //    neutral fill (the WP's own SYNTHETIC_NODE_COLOR precedent), never the outer circle's color.
    expect(level2.color).toBe(level3.color)
    expect(level2.color).not.toBe(outer.color)
  })

  it('a page only 1 folder level deep renders only the outer circle', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.path = 'docs/page'
    nodeA.folder = 'docs'
    nodeA.x = 0
    nodeA.y = 0

    wrapper.vm.computeClusters()

    expect(wrapper.vm.clusters.some((c) => c.level === 2)).toBe(false)
    expect(wrapper.vm.clusters.some((c) => c.level === 3)).toBe(false)
    expect(wrapper.vm.clusters.some((c) => c.key === 'docs' && c.level === undefined)).toBe(true)
  })

  it('draws no nested levels at all outside folder grouping (tag mode)', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.path = 'docs/guides/setup/page'
    nodeA.folder = 'docs'
    nodeA.tags = ['t1']
    nodeA.x = 0
    nodeA.y = 0
    wrapper.vm.groupBy = 'tag'

    wrapper.vm.computeClusters()

    expect(wrapper.vm.clusters.every((c) => c.level === undefined)).toBe(true)
  })
})
