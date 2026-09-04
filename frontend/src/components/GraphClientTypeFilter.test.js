import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import GraphClientTypeFilter from './GraphClientTypeFilter.vue'

const componentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'GraphClientTypeFilter.vue'),
  'utf8'
)

const OPTIONS = [
  { value: 'editor', label: 'Editor' },
  { value: 'mcp', label: 'MCP' }
]

describe('GraphClientTypeFilter', () => {
  it('renders one checkbox per option, checked per modelValue', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      props: { modelValue: ['editor'], label: 'Client type', options: OPTIONS }
    })

    const boxes = wrapper.findAll('.w-checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0].attributes('aria-checked')).toBe('true')
    expect(boxes[1].attributes('aria-checked')).toBe('false')
  })

  it('shows its caption label', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      props: { modelValue: [], label: 'Client type', options: OPTIONS }
    })

    expect(wrapper.text()).toContain('Client type')
  })

  it('emits the option added to modelValue when an unchecked box is clicked', async () => {
    const wrapper = mount(GraphClientTypeFilter, {
      props: { modelValue: ['editor'], label: 'Client type', options: OPTIONS }
    })

    await wrapper.findAll('.w-checkbox')[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')[0]).toEqual([['editor', 'mcp']])
  })

  it('emits the option removed from modelValue when a checked box is clicked', async () => {
    const wrapper = mount(GraphClientTypeFilter, {
      props: { modelValue: ['editor', 'mcp'], label: 'Client type', options: OPTIONS }
    })

    await wrapper.findAll('.w-checkbox')[0].trigger('click')

    expect(wrapper.emitted('update:modelValue')[0]).toEqual([['mcp']])
  })

  it('left-aligns the option rows so every checkbox gets the same x-offset (OpenProject #1290)', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      attachTo: document.body,
      props: { modelValue: [], label: 'Client type', options: OPTIONS }
    })

    // -> `flex-end` (the pre-fix value) right-aligns each row's checkbox+label as one flex item, so
    //    a longer label ("Editor") pushes its checkbox glyph further left than a shorter one ("MCP")
    //    -- `flex-start` anchors every row's checkbox (a fixed-size first element) at the same
    //    x-offset instead, the same effect a fixed-width first grid column would give.
    const style = getComputedStyle(wrapper.get('.graph-client-type-filter-options').element)
    expect(style.alignItems).toBe('flex-start')
  })

  it('left-aligns for a wider option set too (browser/api/mcp)', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      attachTo: document.body,
      props: {
        modelValue: [],
        label: 'Count visits by',
        options: [
          { value: 'browser', label: 'Browser' },
          { value: 'api', label: 'API' },
          { value: 'mcp', label: 'MCP' }
        ]
      }
    })

    const style = getComputedStyle(wrapper.get('.graph-client-type-filter-options').element)
    expect(style.alignItems).toBe('flex-start')
  })

  /**
   * OpenProject #2522: this component sits in a transparent overlay directly over the graph
   * canvas, with no page-level ancestor supplying a dark-aware text color -- its own caption
   * (`.graph-client-type-filter-caption`) had no color rule at all, and the `w-checkbox` option
   * labels are deliberately colorless by design (inheriting from an ancestor). Both fell back to
   * browser-default black in dark mode. As with `Graph.darkMode.test.js`'s OpenProject #2497
   * guard, scoped SCSS `@at-root .body--dark &` nesting is a build-time transform whose cascade
   * isn't reliably assertable via computed style under happy-dom, so this reads the raw SFC
   * source and checks the rule body directly instead.
   */
  describe('dark mode text color (OpenProject #2522)', () => {
    const ruleBodyFor = (selector) => {
      const opener = `${selector} {`
      const start = componentSource.indexOf(opener)
      expect(start, `expected to find "${opener}" in GraphClientTypeFilter.vue`).toBeGreaterThan(-1)

      let depth = 0
      let index = start + opener.length - 1
      do {
        if (componentSource[index] === '{') depth += 1
        else if (componentSource[index] === '}') depth -= 1
        index += 1
      } while (depth > 0 && index < componentSource.length)

      return componentSource.slice(start, index)
    }

    it('.graph-client-type-filter declares a color under both .body--light and .body--dark', () => {
      const body = ruleBodyFor('.graph-client-type-filter')

      const lightMatch = body.match(/@at-root\s+\.body--light\s+&\s*\{([^}]*)\}/)
      expect(
        lightMatch,
        'expected a .body--light block in .graph-client-type-filter'
      ).not.toBeNull()
      expect(lightMatch[1]).toMatch(/color:\s*[^;]+;/)

      const darkMatch = body.match(/@at-root\s+\.body--dark\s+&\s*\{([^}]*)\}/)
      expect(darkMatch, 'expected a .body--dark block in .graph-client-type-filter').not.toBeNull()
      expect(darkMatch[1]).toMatch(/color:\s*[^;]+;/)
    })
  })
})
