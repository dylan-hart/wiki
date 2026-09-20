import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import EditorPickerDialog from './EditorPickerDialog.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * The test i18n instance echoes an unknown key back as itself, so asserting the literal
 * `admin.editors.*` key names is what proves this dialog reuses `AdminEditors.vue`'s own copy.
 */
function mountDialog(editors) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, code: false, markdown: false, wysiwyg: false, ...editors }

  const i18n = createTestI18n()

  const wrapper = mount(EditorPickerDialog, {
    global: { plugins: [i18n] },
    attachTo: document.body
  })

  return { wrapper, siteStore }
}

describe('EditorPickerDialog', () => {
  it('lists only the active editors, with AdminEditors.vue-matching copy', async () => {
    const { wrapper } = mountDialog({ markdown: true, code: true })
    await flushPromises()

    const body = document.body.textContent

    expect(body).toContain('admin.editors.markdownName')
    expect(body).toContain('admin.editors.markdownDescription')
    expect(body).toContain('admin.editors.codeName')
    expect(body).toContain('admin.editors.codeDescription')
    expect(body).not.toContain('admin.editors.wysiwygName')
    expect(body).not.toContain('admin.editors.asciidocName')

    wrapper.unmount()
  })

  it('draws each editor with the Iconify glyph AdminEditors.vue uses, not an empty plate', async () => {
    const { wrapper } = mountDialog({ asciidoc: true, code: true, markdown: true, wysiwyg: true })
    await flushPromises()

    const drawn = [...document.body.querySelectorAll('.w-item .blueprint-icon [data-icon]')].map(
      (el) => el.getAttribute('data-icon')
    )
    expect(drawn).toEqual(['tabler:file-text', 'tabler:code', 'tabler:markdown', 'tabler:forms'])

    wrapper.unmount()
  })

  it('emits ok with the chosen editor id when a row is clicked', async () => {
    const { wrapper } = mountDialog({ markdown: true, wysiwyg: true })
    await flushPromises()

    const items = document.body.querySelectorAll('.w-item')
    expect(items.length).toBe(2)
    items[1].dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(wrapper.emitted('ok')[0][0]).toEqual({ editor: 'wysiwyg' })

    wrapper.unmount()
  })

  it('emits hide with no ok when cancelled', async () => {
    const { wrapper } = mountDialog({ markdown: true, code: true })
    await flushPromises()

    const cancelBtn = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent.includes('common.actions.cancel')
    )
    expect(cancelBtn).toBeTruthy()
    cancelBtn.dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeFalsy()

    wrapper.unmount()
  })
})
