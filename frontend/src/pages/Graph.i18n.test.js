import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/*
 * OpenProject #1690/#1681/#2359: every caption, aria-label, option label, tooltip count and the
 * canvas's own accessible name resolves through `t()` against the `graph.*` keys, never a hardcoded
 * English literal.
 */
describe('Graph.vue i18n and accessible naming', () => {
  it('resolves every control-rail caption, aria-label and option label through t(), not a hardcoded English literal (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.controls.groupByLabel': 'xx-groupBy',
        'graph.controls.groupByFolder': 'xx-folder',
        'graph.controls.groupByTag': 'xx-tag',
        'graph.controls.groupByClassification': 'xx-classification',
        'graph.controls.connectByLabel': 'xx-connectBy',
        'graph.controls.connectByPaths': 'xx-paths',
        'graph.controls.sizeByLabel': 'xx-sizeBy',
        'graph.controls.sizeByEdits': 'xx-edits',
        'graph.controls.countLabel': 'xx-count',
        'graph.controls.countAriaLabel': 'xx-uniqueOrTotal',
        'graph.controls.countUnique': 'xx-unique',
        'graph.controls.countTotal': 'xx-total',
        'graph.controls.editsByLabel': 'xx-editsBy',
        'graph.controls.editsByEditor': 'xx-editor',
        'graph.controls.editsByMcp': 'xx-mcp'
      }
    })

    // -> Every caption, translated option label and control group is visible on mount (the 'edits'
    //    sizing default), so all of these are checkable without any interaction.
    const text = wrapper.text()
    for (const translated of [
      'xx-groupBy',
      'xx-folder',
      'xx-tag',
      'xx-classification',
      'xx-connectBy',
      'xx-paths',
      'xx-sizeBy',
      'xx-edits',
      'xx-count',
      'xx-unique',
      'xx-total',
      'xx-editsBy',
      'xx-editor',
      'xx-mcp'
    ]) {
      expect(text).toContain(translated)
    }
    // -> None of the pre-#1690 English literals leak through -- proves these render via `t()`
    //    resolving the overridden messages above, not a string baked into the template.
    for (const literal of ['Group by', 'Connect by', 'Size by', 'Count edits by']) {
      expect(text).not.toContain(literal)
    }

    expect(wrapper.find('[aria-label="xx-groupBy"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="xx-connectBy"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="xx-sizeBy"]').exists()).toBe(true)
    // -> The 'Count' toggle's aria-label is its own key ('Unique or total'), distinct from its
    //    visible caption ('Count') -- both must resolve through `t()` independently.
    expect(wrapper.find('[aria-label="xx-uniqueOrTotal"]').exists()).toBe(true)
  })

  it('resolves the "visits"-only control rail (Over window, visits client-type filter) through t() (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.controls.overLabel': 'xx-over',
        'graph.controls.overAriaLabel': 'xx-timeWindow',
        'graph.controls.over30Days': 'xx-30days',
        'graph.controls.visitsByLabel': 'xx-visitsBy',
        'graph.controls.visitsByBrowser': 'xx-browser',
        'graph.controls.visitsByApi': 'xx-api',
        'graph.controls.visitsByMcp': 'xx-mcp2'
      }
    })

    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    const text = wrapper.text()
    for (const translated of [
      'xx-over',
      'xx-30days',
      'xx-visitsBy',
      'xx-browser',
      'xx-api',
      'xx-mcp2'
    ]) {
      expect(text).toContain(translated)
    }
    expect(text).not.toContain('30 days')
    expect(text).not.toContain('Count visits by')
    expect(wrapper.find('[aria-label="xx-timeWindow"]').exists()).toBe(true)
  })

  it('renders the hover tooltip\'s contributor count through a real plural message, not an appended "s" (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        // -> Deliberately not just an English 's' suffix -- proves the singular/plural split comes
        //    from vue-i18n's own plural-choice resolution (index 0 for count === 1, index 1
        //    otherwise), not from string concatenation baked into the component.
        'graph.tooltip.contributors': '{count} xx-one-contributor | {count} xx-many-contributors'
      }
    })
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')

    // -> nodeA's edits count is 4 (both contributor types checked, the default) -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('4 xx-many-contributors')
    expect(wrapper.text()).not.toContain('4 contributors')

    // -> Narrowing to just 'mcp' brings nodeA's count down to 1 -> the singular form, not the
    //    plural one -- the old `count === 1 ? '' : 's'` logic could only ever pick between an 's'
    //    suffix and none, never a genuinely different word/form the way a real plural rule can.
    wrapper.vm.contributorTypes = ['mcp']
    await flushPromises()
    expect(wrapper.text()).toContain('1 xx-one-contributor')
    expect(wrapper.text()).not.toContain('1 xx-many-contributors')

    // -> nodeB has zero contributors -> the plural form (English's plural rule treats 0 as plural,
    //    same as the pre-#1690 code's own `0 === 1 ? '' : 's'` -> "0 contributors" behavior).
    wrapper.vm.contributorTypes = ['editor', 'mcp']
    wrapper.vm.hoveredNode = nodeB
    await flushPromises()
    expect(wrapper.text()).toContain('0 xx-many-contributors')
  })

  it("renders the hover tooltip's visit count through a real plural message when sizing by visits (OpenProject #1690)", async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        // -> `sizeCountMode` defaults to 'unique' (OpenProject #2293), so the default visits
        //    tooltip resolves through `graph.tooltip.uniqueVisitors`, not `graph.tooltip.visits`
        //    (that key backs the 'total' count mode instead -- see the sibling 'total' test below).
        'graph.tooltip.uniqueVisitors': '{count} xx-one-visit | {count} xx-many-visits'
      }
    })
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    // -> nodeA's last30d visit count (all client types, the default) is 12 -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('12 xx-many-visits')
    expect(wrapper.text()).not.toContain('12 visits')
  })

  it("renders the hover tooltip's visit count through the 'total' plural message when sizeCountMode is 'total' (OpenProject #2293)", async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.tooltip.visits': '{count} xx-one-total-visit | {count} xx-many-total-visits'
      }
    })
    wrapper.vm.sizeBy = 'visits'
    wrapper.vm.sizeCountMode = 'total'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    // -> nodeA's last30d total (non-distinct) visit count is 30 -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('30 xx-many-total-visits')
  })

  it('gives the canvas role="img" and a computed accessible name reflecting node/link counts and grouping (OpenProject #1681)', async () => {
    const wrapper = await mountGraph()
    const canvas = wrapper.find('canvas')

    expect(canvas.attributes('role')).toBe('img')
    const label = canvas.attributes('aria-label')
    const realPageCount = wrapper.vm.nodes.filter((node) => !node.synthetic).length
    expect(realPageCount).toBe(FIXTURE_GRAPH.nodes.length)
    expect(label).toContain(`${realPageCount} page`)
    expect(label).toContain(`${wrapper.vm.edges.length} link`)
    expect(label).toContain('grouped by folder')
  })

  it('updates the accessible name when groupBy changes (OpenProject #1681)', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.groupBy = 'classification'
    await flushPromises()

    expect(wrapper.find('canvas').attributes('aria-label')).toContain('grouped by classification')
  })

  it('resolves the canvas accessible name through graph.* i18n keys, not a hardcoded English literal (OpenProject #1690, #2359)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.accessibleName.page': '{count} xx-page | {count} xx-pages',
        'graph.accessibleName.link': '{count} xx-link | {count} xx-links',
        'graph.accessibleName.summary': 'xx-summary {pages} :: {links} :: {groupBy}'
      }
    })
    await flushPromises()

    const label = wrapper.find('canvas').attributes('aria-label')
    const realPageCount = wrapper.vm.nodes.filter((node) => !node.synthetic).length
    const linkCount = wrapper.vm.edges.length
    const pageWord = realPageCount === 1 ? 'xx-page' : 'xx-pages'
    const linkWord = linkCount === 1 ? 'xx-link' : 'xx-links'

    expect(label).toBe(
      `xx-summary ${realPageCount} ${pageWord} :: ${linkCount} ${linkWord} :: folder`
    )
  })
})
