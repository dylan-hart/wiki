import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import EditorMentionList from './EditorMentionList.vue'

import { createTestI18n } from '../../test/i18n.js'

function mountList(props) {
  const i18n = createTestI18n()
  return mount(EditorMentionList, {
    props: { command: vi.fn(), ...props },
    global: { plugins: [i18n] }
  })
}

describe('EditorMentionList', () => {
  it('shows a prompt instead of a blank popover when nothing has been typed after @ yet', () => {
    const wrapper = mountList({ items: [], query: '', loading: false })

    expect(wrapper.text()).toContain('editor.mention.prompt')
    expect(wrapper.text()).not.toContain('editor.mention.noResults')
  })

  it('shows a "no results" message, not a blank popover, when a real search finds nothing', () => {
    const wrapper = mountList({ items: [], query: 'zzz-nonexistent', loading: false })

    expect(wrapper.text()).toContain('editor.mention.noResults')
    expect(wrapper.text()).not.toContain('editor.mention.prompt')
  })

  it('shows a loading message while a query is in flight, even before items or query settle', () => {
    const wrapper = mountList({ items: [], query: 'fa', loading: true })

    expect(wrapper.text()).toContain('editor.mention.loading')
  })

  it('lists the candidate pages and selects one on click', async () => {
    const command = vi.fn()
    const wrapper = mountList({
      items: [
        { id: 'help/faq', label: 'FAQ', path: 'help/faq', icon: 'tabler:help' },
        { id: 'help/guide', label: 'Guide', path: 'help/guide', icon: 'tabler:book' }
      ],
      query: 'help',
      loading: false,
      command
    })

    expect(wrapper.text()).toContain('FAQ')
    expect(wrapper.text()).toContain('Guide')

    const rows = wrapper.findAll('.w-item')
    await rows[1].trigger('click')

    expect(command).toHaveBeenCalledWith({
      id: 'help/guide',
      label: 'Guide',
      path: 'help/guide',
      icon: 'tabler:book'
    })
  })

  it('navigates with the arrow keys and confirms with Enter, wrapping at the ends', () => {
    const command = vi.fn()
    const wrapper = mountList({
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' }
      ],
      query: 'x',
      loading: false,
      command
    })

    // -> Starts on row 0; wraps backward past the start to the last row.
    expect(wrapper.vm.onKeyDown({ event: { key: 'ArrowUp' } })).toBe(true)
    expect(wrapper.vm.onKeyDown({ event: { key: 'Enter' } })).toBe(true)
    expect(command).toHaveBeenCalledWith({ id: 'c', label: 'C' })

    command.mockClear()
    // -> ArrowDown from the wrapped last row goes back to the first.
    expect(wrapper.vm.onKeyDown({ event: { key: 'ArrowDown' } })).toBe(true)
    expect(wrapper.vm.onKeyDown({ event: { key: 'Enter' } })).toBe(true)
    expect(command).toHaveBeenCalledWith({ id: 'a', label: 'A' })
  })

  it('leaves unrelated keys unhandled, and every key unhandled when the list is empty', () => {
    const populated = mountList({ items: [{ id: 'a', label: 'A' }], query: 'x', loading: false })
    expect(populated.vm.onKeyDown({ event: { key: 'Tab' } })).toBe(false)

    const empty = mountList({ items: [], query: 'x', loading: false })
    expect(empty.vm.onKeyDown({ event: { key: 'Enter' } })).toBe(false)
    expect(empty.vm.onKeyDown({ event: { key: 'ArrowDown' } })).toBe(false)
  })
})
