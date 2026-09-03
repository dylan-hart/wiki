import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2478 (Feature #2414's Scope): the graph filter panel's keyword input. This is
 * deliberately UI-only coverage -- no network call and no effect on the rendered graph yet. Wiring
 * the keyword to `GET sites/:siteId/pages/search` (#2479) and highlighting matched nodes (#2480) are
 * separate work packages with their own suites once they land.
 */
describe('Graph.vue filter panel keyword input (OpenProject #2478)', () => {
  it('renders a w-input labeled via graph.filters.keyword, alongside the tags/folderDepth/locale controls', async () => {
    const wrapper = await mountGraph({
      messageOverrides: { 'graph.filters.keyword': 'xx-keyword' }
    })

    const panel = wrapper.find('.graph-view-filters')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('xx-keyword')
    // -> A w-input, not a w-select: an existing Graph.fallback.test.js test counts `.w-select`s
    //    under this same panel to assert the locale filter's own visibility, so the keyword control
    //    must not add one.
    expect(panel.findAll('.w-input').length).toBeGreaterThan(0)
  })

  it('binds the input to keywordQuery, starting empty', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.keywordQuery).toBe('')

    // -> The keyword input is the first control rendered in the filter panel.
    const input = wrapper.find('.graph-view-filters input')
    expect(input.exists()).toBe(true)

    await input.setValue('onboarding')
    expect(wrapper.vm.keywordQuery).toBe('onboarding')
  })

  it('typing a keyword does not narrow the visible node/edge set -- distinct from tags/folderDepth/locale (OpenProject #2414)', async () => {
    const wrapper = await mountGraph()

    const nodesBefore = wrapper.vm.nodes.length
    const edgesBefore = wrapper.vm.edges.length

    wrapper.vm.keywordQuery = 'onboarding'
    await flushPromises()

    expect(wrapper.vm.nodes.length).toBe(nodesBefore)
    expect(wrapper.vm.edges.length).toBe(edgesBefore)
  })

  it('keeps keywordQuery untouched by clearFilters() / the "Clear filters" action', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = 'onboarding'
    wrapper.vm.activeFilters.tags = ['guides']
    await flushPromises()

    wrapper.vm.clearFilters()
    await flushPromises()

    expect(wrapper.vm.activeFilters.tags).toEqual([])
    expect(wrapper.vm.keywordQuery).toBe('onboarding')
  })
})
