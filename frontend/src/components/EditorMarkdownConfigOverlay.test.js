import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import EditorMarkdownConfigOverlay from './EditorMarkdownConfigOverlay.vue'

import { mountWithApp } from '../../test/mount.js'

const MESSAGES = {
  'admin.editors.markdownName': 'Markdown',
  'admin.editors.markdown.general': 'General',
  'admin.editors.markdown.allowHTML': 'Allow HTML',
  'admin.editors.markdown.allowHTMLHint': 'Allow HTML tags in content.',
  'admin.editors.markdown.linkify': 'Auto-linking',
  'admin.editors.markdown.linkifyHint': 'Automatically convert URLs into clickable links.',
  'admin.editors.markdown.lineBreaks': 'Auto Line Breaks',
  'admin.editors.markdown.lineBreaksHint': 'Automatically add linebreaks within paragraphs.',
  'admin.editors.markdown.tabWidth': 'Code Block Tab Width',
  'admin.editors.markdown.tabWidthHint': 'Amount of spaces for each tab in code blocks.',
  'admin.editors.markdown.tabWidthInvalid': 'Tab width must be a whole number between 1 and 8.',
  'admin.editors.markdown.multimdTable': 'MultiMarkdown Table',
  'admin.editors.markdown.multimdTableHint': 'Enable support for MultiMarkdown Table features.',
  'admin.editors.markdown.typographer': 'Typographer',
  'admin.editors.markdown.typographerHint':
    'Enable some language-neutral replacement + quotes beautification.',
  'admin.editors.markdown.underline': 'Underline Emphasis',
  'admin.editors.markdown.underlineHint': 'Enable text underlining by using _underline_ syntax.',
  'admin.editors.markdown.saveSuccess': 'Markdown editor configuration saved successfully.',
  'common.actions.refresh': 'Refresh',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save'
}

function mountOverlay() {
  return mountWithApp(EditorMarkdownConfigOverlay, { messages: MESSAGES }).wrapper
}

function findSaveButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text().includes('Save'))
}

/*
  #1796: `min`/`max` on the native number control stop the spinner, not a pasted value, and nothing
  server-side enforces the shape either -- `backend/api/schemas/site.ts` types
  `editors.markdown.config` as `additionalProperties: true`. The `rules` array wired onto this field
  is what actually keeps a `0` (or any non-integer) out.
*/
describe('EditorMarkdownConfigOverlay tab width validation', () => {
  it('rejects a tabWidth of 0 and does not PUT the config', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          editors: {
            markdown: {
              config: {
                allowHTML: true,
                linkify: true,
                lineBreaks: true,
                typographer: false,
                quotes: 'english',
                underline: true,
                tabWidth: 2,
                multimdTable: true
              }
            }
          }
        })
    })
    const wrapper = mountOverlay()
    await flushPromises()

    wrapper.vm.state.config.tabWidth = 0
    await wrapper.vm.$nextTick()

    await findSaveButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Tab width must be a whole number between 1 and 8.')
  })

  it('saves a valid tabWidth', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          editors: {
            markdown: {
              config: {
                allowHTML: true,
                linkify: true,
                lineBreaks: true,
                typographer: false,
                quotes: 'english',
                underline: true,
                tabWidth: 2,
                multimdTable: true
              }
            }
          }
        })
    })
    const wrapper = mountOverlay()
    await flushPromises()

    wrapper.vm.state.config.tabWidth = 4
    await wrapper.vm.$nextTick()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await findSaveButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [, opts] = API_CLIENT.put.mock.calls[0]
    expect(opts.json.editors.markdown.config.tabWidth).toBe(4)
  })
})
