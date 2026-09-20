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

    it('adds the hover class when a node moves under a stationary pointer', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
      nodeA.x = -500
      nodeA.y = -500
      nodeB.x = -900
      nodeB.y = -900
      wrapper.vm.relayout()

      await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
      expect(wrapper.vm.hoveredNode).toBeNull()

      nodeA.x = 500
      nodeA.y = 500
      wrapper.vm.relayout()
      await flushPromises()

      expect(wrapper.vm.hoveredNode).toBe(nodeA)
      expect(wrapper.find('.graph-view-canvas').classes()).toContain('graph-view-canvas--hover')
    })

    it('removes the hover class when the hovered node drifts out from under a stationary pointer', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
      nodeA.x = 500
      nodeA.y = 500
      nodeB.x = -900
      nodeB.y = -900
      wrapper.vm.relayout()
      await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
      expect(wrapper.find('.graph-view-canvas').classes()).toContain('graph-view-canvas--hover')

      nodeA.x = -500
      nodeA.y = -500
      wrapper.vm.relayout()
      await flushPromises()

      expect(wrapper.vm.hoveredNode).toBeNull()
      expect(wrapper.find('.graph-view-canvas').classes()).not.toContain('graph-view-canvas--hover')
    })

    it('clears the hover class and releases the pin when the hovered node is filtered out', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
      nodeA.x = 500
      nodeA.y = 500
      nodeB.x = -900
      nodeB.y = -900
      wrapper.vm.relayout()
      await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
      expect(wrapper.vm.hoveredNode).toBe(nodeA)

      wrapper.vm.activeFilters.tags = ['nonexistent-tag']
      await flushPromises()
      wrapper.vm.relayout()
      await flushPromises()

      expect(wrapper.vm.nodes).not.toContain(nodeA)
      expect(wrapper.vm.hoveredNode).toBeNull()
      expect(nodeA.fx).toBeNull()
      expect(wrapper.find('.graph-view-canvas').classes()).not.toContain('graph-view-canvas--hover')
    })

    it('stops re-testing the pointer once it has left the canvas', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
      nodeA.x = -500
      nodeA.y = -500
      nodeB.x = -900
      nodeB.y = -900
      wrapper.vm.relayout()
      await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
      await wrapper.find('canvas').trigger('mouseleave')

      nodeA.x = 500
      nodeA.y = 500
      wrapper.vm.relayout()
      await flushPromises()

      expect(wrapper.vm.hoveredNode).toBeNull()
    })

    it('shows the tooltip but not the pointer cursor over a synthetic folder node', async () => {
      const wrapper = await mountGraph({
        graph: {
          nodes: [
            {
              path: 'guides/one',
              locale: 'en',
              title: 'One',
              icon: null,
              tags: [],
              folder: 'guides'
            },
            {
              path: 'guides/two',
              locale: 'en',
              title: 'Two',
              icon: null,
              tags: [],
              folder: 'guides'
            }
          ],
          edges: []
        }
      })
      const folder = wrapper.vm.nodes.find((node) => node.synthetic && node.path === 'guides')
      for (const node of wrapper.vm.nodes) {
        node.x = node === folder ? 500 : -900
        node.y = node === folder ? 500 : -900
      }
      wrapper.vm.relayout()

      await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
      await flushPromises()

      expect(wrapper.vm.hoveredNode).toBe(folder)
      expect(wrapper.find('.graph-view-tooltip').exists()).toBe(true)
      expect(wrapper.find('.graph-view-canvas').classes()).not.toContain('graph-view-canvas--hover')
    })
  })
})
