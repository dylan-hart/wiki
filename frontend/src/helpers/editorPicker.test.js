import { describe, expect, it, vi } from 'vitest'

import { PICKABLE_EDITORS, pickEditor } from './editorPicker'

/**
 * Regression coverage for task 493: every new-page entry point used to hardcode `editor: 'markdown'`
 * even though the site could have more than one editor active. `pickEditor()` is what both
 * `Index.vue`'s `createPage()` and any future entry point call instead -- it is the one place that
 * decides "ask, or just answer" so that decision cannot drift between callers.
 */
describe('pickEditor', () => {
  it('answers directly with the one active editor, without opening a dialog', async () => {
    const siteStore = { editors: { asciidoc: false, code: false, markdown: true, wysiwyg: false } }
    const dialogFn = vi.fn()

    const result = await pickEditor(siteStore, dialogFn)

    expect(result).toBe('markdown')
    expect(dialogFn).not.toHaveBeenCalled()
  })

  it('falls back to markdown, without opening a dialog, when no editor is active', async () => {
    const siteStore = { editors: { asciidoc: false, code: false, markdown: false, wysiwyg: false } }
    const dialogFn = vi.fn()

    const result = await pickEditor(siteStore, dialogFn)

    expect(result).toBe('markdown')
    expect(dialogFn).not.toHaveBeenCalled()
  })

  it('opens the dialog and resolves with the chosen editor when more than one is active', async () => {
    const siteStore = { editors: { asciidoc: false, code: true, markdown: true, wysiwyg: false } }
    const onOk = vi.fn((cb) => {
      cb({ editor: 'code' })
      return chain
    })
    const chain = { onOk, onCancel: vi.fn(() => chain) }
    const dialogFn = vi.fn(() => chain)

    const result = await pickEditor(siteStore, dialogFn)

    expect(dialogFn).toHaveBeenCalledWith(expect.objectContaining({ component: expect.anything() }))
    expect(result).toBe('code')
  })

  it('resolves null when the dialog is cancelled', async () => {
    const siteStore = { editors: { code: true, markdown: true } }
    const onCancel = vi.fn((cb) => {
      cb()
      return chain
    })
    const chain = { onOk: vi.fn(() => chain), onCancel }
    const dialogFn = vi.fn(() => chain)

    const result = await pickEditor(siteStore, dialogFn)

    expect(result).toBeNull()
  })

  it('excludes redirect from the pickable list -- it authors no content', () => {
    expect(PICKABLE_EDITORS).not.toContain('redirect')
  })
})
