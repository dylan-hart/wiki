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

// Reads a top-level SCSS rule's body (opening `selector {` through its matching `}`) straight out
// of an SFC's source, for a style assertion scoped SCSS `@at-root` nesting can't reliably make via
// computed style under happy-dom -- shared by the #2522 and #2893 guards below.
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
    expect(style.flexDirection).toBe('row')
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
    expect(style.flexDirection).toBe('row')
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
    it('.graph-client-type-filter declares a color under both .body--light and .body--dark', () => {
      const body = ruleBodyFor(componentSource, '.graph-client-type-filter')

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

  /**
   * OpenProject #2893: the "Count edits/visits by" caption used to render as a plain 11px,
   * 70%-opacity label -- a different font family, size, weight, letter-spacing and casing than
   * `Graph.vue`'s `.graph-view-control-caption`, which GROUP BY/SIZE BY/the filter captions all
   * use. Reads both raw SFC sources rather than mounting + computed style, for the same
   * `@at-root` reason the #2522 guard above does.
   */
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

      const lightMatch = body.match(/@at-root\s+\.body--light\s+&\s*\{([^}]*)\}/)
      expect(lightMatch, 'expected a .body--light block').not.toBeNull()
      expect(lightMatch[1]).toMatch(/color:\s*var\(--color-text-caption\);/)

      const darkMatch = body.match(/@at-root\s+\.body--dark\s+&\s*\{([^}]*)\}/)
      expect(darkMatch, 'expected a .body--dark block').not.toBeNull()
      expect(darkMatch[1]).toMatch(/color:\s*var\(--color-text-caption-dark\);/)
    })
  })
})
