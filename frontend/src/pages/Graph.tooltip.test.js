import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * The hover tooltip's noun (OpenProject #2293): it must name what the CURRENT sizing mode actually
 * counts -- contributors, edits, unique visitors or visits -- not one hardcoded word.
 */
describe('Graph.vue hover tooltip', () => {
  // -> OpenProject #2293: the tooltip noun must follow `sizeCountMode` as well as `sizeBy` --
  //    'total' reads raw, non-distinct row counts (an edit/visit tally) while 'unique' reads
  //    distinct-identity counts (a contributor/visitor tally), so two of the four combinations
  //    need a noun that differs from the other two sharing the same `sizeBy`.
  describe('hover tooltip noun (OpenProject #2293)', () => {
    it('names edits + unique sizing "contributor(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('4 contributors')
    })

    it('names edits + total sizing "edit(s)", not "contributor(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'total'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      const tooltipText = wrapper.find('.graph-view-tooltip').text()
      expect(tooltipText).toContain('9 edits')
      expect(tooltipText).not.toContain('contributor')
    })

    it('names visits + unique sizing "unique visitor(s)", not "visit(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'visits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      const tooltipText = wrapper.find('.graph-view-tooltip').text()
      expect(tooltipText).toContain('12 unique visitors')
      expect(tooltipText).not.toMatch(/\b12 visits\b/)
    })

    it('names visits + total sizing "visit(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'visits'
      wrapper.vm.sizeCountMode = 'total'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('30 visits')
    })

    it('singularizes the noun for a count of exactly one', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.contributorTypes = ['mcp']
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('1 contributor')
      expect(wrapper.find('.graph-view-tooltip').text()).not.toContain('1 contributors')
    })
  })
})
