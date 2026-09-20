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

const graphSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'Graph.vue'),
  'utf8'
)

const OPTIONS = [
  { value: 'editor', label: 'Editor' },
  { value: 'mcp', label: 'MCP' }
]

// Reads a rule's body (`selector {` through its matching `}`) straight out of an SFC's source:
// happy-dom's computed style cannot reliably resolve a scoped, nested rule's cascade.
const ruleBodyFor = (source, selector) => {
  const opener = `${selector} {`
  const start = source.indexOf(opener)
  expect(start, `expected to find "${opener}"`).toBeGreaterThan(-1)

  let depth = 0
  let index = start + opener.length - 1
  do {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') depth -= 1
    index += 1
  } while (depth > 0 && index < source.length)

  return source.slice(start, index)
}

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

  // `segment-selected` resolves to `--color-accent` under Cobalt and `--color-primary` under
  // Ledger, so the panel's checkboxes and toggle buttons match in both aesthetics.
  it('passes color="segment-selected" to its checkboxes, matching WBtnToggle (OpenProject #3030)', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      props: { modelValue: ['editor'], label: 'Client type', options: OPTIONS }
    })

    for (const checkbox of wrapper.findAllComponents({ name: 'WCheckbox' })) {
      expect(checkbox.props('color')).toBe('segment-selected')
    }
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

  it('renders its options as a single horizontal row, not one per line (OpenProject #2855/#2828)', () => {
    const wrapper = mount(GraphClientTypeFilter, {
      attachTo: document.body,
      props: { modelValue: [], label: 'Client type', options: OPTIONS }
    })

    const style = getComputedStyle(wrapper.get('.graph-client-type-filter-options').element)
    // -> `flexFlow`, not `flexDirection`: lightningcss coalesces the source's `flex-direction: row`
    //    and `flex-wrap: wrap` into `flex-flow: wrap` (dropping `row` as the initial value), and
    //    happy-dom never expands a shorthand back into longhands, so `flexDirection` reads empty.
    expect(style.flexFlow).toBe('wrap')
  })

  it('renders as a single row for a wider option set too (browser/api/mcp, OpenProject #2855/#2828)', () => {
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
    expect(style.flexFlow).toBe('wrap')
  })

  describe('row fill and caption alignment (OpenProject #3527)', () => {
    it('left-aligns its caption and stretches to the panel width', () => {
      const body = ruleBodyFor(componentSource, '.graph-client-type-filter')
      expect(body).toMatch(/align-items:\s*stretch/)
      expect(body).not.toMatch(/align-items:\s*flex-end/)
    })

    it('gives each checkbox an equal share of the row and no longer right-packs it', () => {
      const body = ruleBodyFor(componentSource, '.graph-client-type-filter-options')
      expect(body).toMatch(/:deep\(\.w-checkbox\)\s*\{\s*flex:\s*1 1 0;/)
      expect(body).not.toMatch(/justify-content/)
    })
  })

  // Nothing above this component in the overlay supplies a dark-aware text color, and the checkbox
  // labels are colorless by design, so both themes must be declared here or both fall back to black.
  describe('dark mode text color (OpenProject #2522)', () => {
    it('.graph-client-type-filter declares a color under both .body--light and .body--dark', () => {
      const body = ruleBodyFor(componentSource, '.graph-client-type-filter')

      const lightMatch = body.match(/\.body--light\s+&\s*\{([^}]*)\}/)
      expect(
        lightMatch,
        'expected a .body--light block in .graph-client-type-filter'
      ).not.toBeNull()
      expect(lightMatch[1]).toMatch(/color:\s*[^;]+;/)

      const darkMatch = body.match(/\.body--dark\s+&\s*\{([^}]*)\}/)
      expect(darkMatch, 'expected a .body--dark block in .graph-client-type-filter').not.toBeNull()
      expect(darkMatch[1]).toMatch(/color:\s*[^;]+;/)
    })
  })

  describe('caption style matches Graph.vue GROUP BY/SIZE BY captions (OpenProject #2893)', () => {
    it('shares font-family/size/weight/letter-spacing/text-transform with .graph-view-control-caption', () => {
      const filterCaptionBody = ruleBodyFor(componentSource, '.graph-client-type-filter-caption')
      const graphCaptionBody = ruleBodyFor(graphSource, '.graph-view-control-caption')

      for (const property of [
        'font-family',
        'font-size',
        'font-weight',
        'letter-spacing',
        'text-transform'
      ]) {
        const filterValue = filterCaptionBody.match(new RegExp(`${property}:\\s*([^;]+);`))
        const graphValue = graphCaptionBody.match(new RegExp(`${property}:\\s*([^;]+);`))

        expect(
          filterValue,
          `expected ${property} on .graph-client-type-filter-caption`
        ).not.toBeNull()
        expect(graphValue, `expected ${property} on .graph-view-control-caption`).not.toBeNull()
        expect(filterValue[1]).toBe(graphValue[1])
      }
    })

    it('no longer sets its own opacity (the old, mismatched style)', () => {
      const filterCaptionBody = ruleBodyFor(componentSource, '.graph-client-type-filter-caption')

      expect(filterCaptionBody).not.toMatch(/opacity:/)
    })

    it('declares the caption color tokens under both .body--light and .body--dark', () => {
      const body = ruleBodyFor(componentSource, '.graph-client-type-filter-caption')

      const lightMatch = body.match(/\.body--light\s+&\s*\{([^}]*)\}/)
      expect(lightMatch, 'expected a .body--light block').not.toBeNull()
      expect(lightMatch[1]).toMatch(/color:\s*var\(--color-text-caption\);/)

      const darkMatch = body.match(/\.body--dark\s+&\s*\{([^}]*)\}/)
      expect(darkMatch, 'expected a .body--dark block').not.toBeNull()
      expect(darkMatch[1]).toMatch(/color:\s*var\(--color-text-caption-dark\);/)
    })
  })
})
