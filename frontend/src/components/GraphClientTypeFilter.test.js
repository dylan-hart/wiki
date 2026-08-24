import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import GraphClientTypeFilter from './GraphClientTypeFilter.vue'

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
})
