import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

/**
 * Both of `EditorMarkdown.vue`'s toolbars implement the WAI-ARIA APG "Toolbar" roving-tabindex
 * pattern (`composables/toolbarRovingTabindex.js`, unit-tested on its own), so Tab from the page
 * description lands on the Monaco editor rather than working through every toolbar button first.
 * `attachTo: document.body` is needed throughout -- `document.activeElement` and `.focus()` only
 * behave meaningfully for a connected element.
 */
function mountEditor(initialContent) {
  return mountEditorMarkdown(EditorMarkdown, initialContent, { attachTo: document.body })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EditorMarkdown side toolbar (insert toolbar) roving tabindex', () => {
  it('renders as a labelled, vertical toolbar', async () => {
    const { wrapper } = await mountEditor('')

    const toolbar = wrapper.find('.editor-markdown-sidebar')
    expect(toolbar.attributes('role')).toBe('toolbar')
    expect(toolbar.attributes('aria-orientation')).toBe('vertical')
    expect(toolbar.attributes('aria-label')).toBe('editor.markup.insertToolbarLabel')
  })

  it('is a single Tab stop: only the first button carries tabindex="0"', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-sidebar > .w-btn')
    expect(buttons).toHaveLength(10)
    expect(buttons[0].attributes('tabindex')).toBe('0')
    for (const button of buttons.slice(1)) {
      expect(button.attributes('tabindex')).toBe('-1')
    }
  })

  it('ArrowDown moves both real focus and the roving tab stop to the next button', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-sidebar > .w-btn')
    buttons[0].element.focus()

    await wrapper.find('.editor-markdown-sidebar').trigger('keydown', { key: 'ArrowDown' })

    expect(document.activeElement).toBe(buttons[1].element)
    expect(buttons[1].attributes('tabindex')).toBe('0')
    expect(buttons[0].attributes('tabindex')).toBe('-1')
  })

  it('ArrowUp from the first button wraps to the last', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-sidebar > .w-btn')
    buttons[0].element.focus()

    await wrapper.find('.editor-markdown-sidebar').trigger('keydown', { key: 'ArrowUp' })

    expect(document.activeElement).toBe(buttons[9].element)
    expect(buttons[9].attributes('tabindex')).toBe('0')
  })

  it('a mouse click resyncs the roving tab stop to the clicked button', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-sidebar > .w-btn')
    buttons[4].element.focus()
    await wrapper.find('.editor-markdown-sidebar').trigger('focusin')

    expect(buttons[4].attributes('tabindex')).toBe('0')
    expect(buttons[0].attributes('tabindex')).toBe('-1')
  })
})

describe('EditorMarkdown top toolbar (formatting toolbar) roving tabindex', () => {
  it('renders as a labelled, horizontal toolbar', async () => {
    const { wrapper } = await mountEditor('')

    const toolbar = wrapper.find('.editor-markdown-toolbar')
    expect(toolbar.attributes('role')).toBe('toolbar')
    expect(toolbar.attributes('aria-orientation')).toBe('horizontal')
    expect(toolbar.attributes('aria-label')).toBe('editor.markup.formattingToolbarLabel')
  })

  it('is a single Tab stop: only the first button carries tabindex="0"', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-toolbar > .w-btn')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons[0].attributes('tabindex')).toBe('0')
    for (const button of buttons.slice(1)) {
      expect(button.attributes('tabindex')).toBe('-1')
    }
  })

  it('ArrowRight moves both real focus and the roving tab stop to the next button', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-toolbar > .w-btn')
    buttons[0].element.focus()

    await wrapper.find('.editor-markdown-toolbar').trigger('keydown', { key: 'ArrowRight' })

    expect(document.activeElement).toBe(buttons[1].element)
    expect(buttons[1].attributes('tabindex')).toBe('0')
  })

  it('End jumps to the last button, including the conditionally-rendered preview toggle', async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-toolbar > .w-btn')
    const last = buttons[buttons.length - 1]
    // -> Only rendered while the preview pane is closed, which is the mount's own default state
    expect(last.attributes('aria-label')).toBeUndefined()
    buttons[0].element.focus()

    await wrapper.find('.editor-markdown-toolbar').trigger('keydown', { key: 'End' })

    expect(document.activeElement).toBe(last.element)
    expect(last.attributes('tabindex')).toBe('0')
  })

  it("does not move focus for a key it doesn't handle, e.g. Tab itself", async () => {
    const { wrapper } = await mountEditor('')

    const buttons = wrapper.findAll('.editor-markdown-toolbar > .w-btn')
    buttons[0].element.focus()

    await wrapper.find('.editor-markdown-toolbar').trigger('keydown', { key: 'Tab' })

    expect(document.activeElement).toBe(buttons[0].element)
    expect(buttons[0].attributes('tabindex')).toBe('0')
  })
})

describe('EditorMarkdown side and top toolbars roll independently', () => {
  it('moving within the top toolbar leaves the side toolbar’s own roving index untouched', async () => {
    const { wrapper } = await mountEditor('')

    const sideButtons = wrapper.findAll('.editor-markdown-sidebar > .w-btn')
    const topButtons = wrapper.findAll('.editor-markdown-toolbar > .w-btn')

    topButtons[0].element.focus()
    await wrapper.find('.editor-markdown-toolbar').trigger('keydown', { key: 'ArrowRight' })

    expect(sideButtons[0].attributes('tabindex')).toBe('0')
    expect(topButtons[1].attributes('tabindex')).toBe('0')
  })
})
