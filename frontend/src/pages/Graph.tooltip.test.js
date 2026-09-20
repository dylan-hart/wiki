import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

describe('Graph.vue hover tooltip', () => {
  // -> The noun follows `sizeCountMode` as well as `sizeBy`: 'total' counts raw, non-distinct rows
  //    (edits, visits) while 'unique' counts distinct identities (contributors, visitors).
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

  // -> A canvas has no native hoverable elements, so the pointer cursor has to be driven off the
  //    same `hoveredNode` ref the tooltip already reacts to.
  describe('hover cursor (OpenProject #2888)', () => {
    it('has no hover class when no node is hovered', async () => {
      const wrapper = await mountGraph()
      await flushPromises()

      expect(wrapper.find('.graph-view-canvas').classes()).not.toContain('graph-view-canvas--hover')
    })

    it('adds the hover class once a node is hovered', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-canvas').classes()).toContain('graph-view-canvas--hover')
    })

    it('removes the hover class once the pointer leaves every node', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()
      expect(wrapper.find('.graph-view-canvas').classes()).toContain('graph-view-canvas--hover')

      wrapper.vm.hoveredNode = null
      await flushPromises()

      expect(wrapper.find('.graph-view-canvas').classes()).not.toContain('graph-view-canvas--hover')
    })
  })
})
