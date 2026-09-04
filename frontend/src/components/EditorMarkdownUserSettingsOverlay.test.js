import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import EditorMarkdownUserSettingsOverlay from './EditorMarkdownUserSettingsOverlay.vue'
import { useEditorStore } from '@/stores/editor'

import { createTestI18n } from '../../test/i18n.js'

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

function mountOverlay({ overlayOpts } = {}) {
  setActivePinia(createPinia())
  const editorStore = useEditorStore()
  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(EditorMarkdownUserSettingsOverlay, {
    props: overlayOpts ? { overlayOpts } : {},
    global: { plugins: [i18n] }
  })
  return { wrapper, editorStore }
}

function findApplyButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text().includes('Apply'))
}

/*
  This overlay's `save()` PUTs a full replacement of `users/profile/editor-settings/markdown` (see
  the endpoint's own doc comment in `backend/api/users/profile.ts`) -- so `previewWidth`, which
  `EditorMarkdown.vue`'s resize divider sets and this overlay offers no control for, has to survive a
  save made here untouched, or dragging the divider and later changing the font size in this overlay
  would silently erase the dragged width.
*/
/*
  `WInput` used to leave `min`/`max`/`step` off its inner control entirely (they fell through onto
  the outer wrapper `<div>` instead), so this field's advertised 10-32 range was never actually
  enforced by the browser. Asserting the real rendered `<input>` carries them is what proves that
  regression stays fixed here, at the one call site the range is meant to protect.
*/
/**
 * OpenProject #2530: `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it
 * mounts as this prop -- this overlay has no use for it, but must still declare it, or the value
 * falls through onto its rendered DOM root as a stray attribute.
 */
describe('EditorMarkdownUserSettingsOverlay overlayOpts prop (OpenProject #2530)', () => {
  it('declares overlayOpts as a prop, so it does not fall through onto the rendered DOM root', () => {
    const { wrapper } = mountOverlay({ overlayOpts: { unused: true } })

    expect(wrapper.attributes('overlay-opts')).toBeUndefined()
  })
})

describe('EditorMarkdownUserSettingsOverlay font size range', () => {
  it('renders the 10-32 min/max on the actual font size <input>, not just the outer wrapper', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ previewShown: true, fontSize: 16, previewWidth: null })
    })
    const { wrapper } = mountOverlay()
    await flushPromises()

    const fontSizeInput = wrapper.find('input[type="number"]')
    expect(fontSizeInput.attributes('min')).toBe('10')
    expect(fontSizeInput.attributes('max')).toBe('32')
  })
})

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
