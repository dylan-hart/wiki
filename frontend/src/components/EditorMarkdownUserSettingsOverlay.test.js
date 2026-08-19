import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import EditorMarkdownUserSettingsOverlay from './EditorMarkdownUserSettingsOverlay.vue'
import { useEditorStore } from '@/stores/editor'

const MESSAGES = {
  'common.actions.apply': 'Apply',
  'common.actions.cancel': 'Cancel',
  'common.actions.refresh': 'Refresh',
  'editor.settings.markdown': 'Markdown Editor Settings',
  'editor.settings.markdownFontSize': 'Editor Font Size',
  'editor.settings.markdownFontSizeHint': 'The font size to use in the editor.',
  'editor.settings.markdownPreviewShown': 'Display Render Preview',
  'editor.settings.markdownPreviewShownHint':
    'Whether to display a preview of the rendered content.',
  'editor.settings.saveSuccess': 'Editor settings saved successfully.'
}

function mountOverlay() {
  setActivePinia(createPinia())
  const editorStore = useEditorStore()
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  const wrapper = mount(EditorMarkdownUserSettingsOverlay, {
    global: { plugins: [i18n] }
  })
  return { wrapper, editorStore }
}

function findApplyButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text().includes('Apply'))
}

/*
  This overlay's `save()` PUTs a full replacement of `users/profile/editor-settings/markdown` (see
  the endpoint's own doc comment in `backend/api/users.ts`) -- so `previewWidth`, which
  `EditorMarkdown.vue`'s resize divider sets and this overlay offers no control for, has to survive a
  save made here untouched, or dragging the divider and later changing the font size in this overlay
  would silently erase the dragged width.
*/
describe('EditorMarkdownUserSettingsOverlay preview width round-trip', () => {
  it('carries a saved previewWidth through save() even though nothing here edits it', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ previewShown: true, fontSize: 18, previewWidth: 480 })
    })
    const { wrapper } = mountOverlay()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await findApplyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile/editor-settings/markdown', {
      json: { previewShown: true, fontSize: 18, previewWidth: 480 }
    })
  })

  it('saves previewWidth as null, not omitted, when nothing was ever dragged', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ previewShown: true, fontSize: 16 })
    })
    const { wrapper } = mountOverlay()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await findApplyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile/editor-settings/markdown', {
      json: { previewShown: true, fontSize: 16, previewWidth: null }
    })
  })

  it('patches editorStore.userSettings.markdown on a successful save, so a still-mounted editor reads the update', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ previewShown: false, fontSize: 16, previewWidth: 300 })
    })
    const { wrapper, editorStore } = mountOverlay()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await findApplyButton(wrapper).trigger('click')
    await flushPromises()

    expect(editorStore.userSettings.markdown).toEqual({
      previewShown: false,
      fontSize: 16,
      previewWidth: 300
    })
  })
})
