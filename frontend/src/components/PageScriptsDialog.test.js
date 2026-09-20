import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageScriptsDialog from './PageScriptsDialog.vue'
import { mountWithApp } from '../../test/mount.js'

const MESSAGES = {
  editor: {
    pageScripts: { title: 'Page Scripts' },
    props: {
      jsLoad: 'Javascript - On Load',
      jsUnload: 'Javascript - On Unload',
      styles: 'CSS Styles'
    }
  },
  common: { actions: { discard: 'Discard', save: 'Save' } }
}

describe('PageScriptsDialog', () => {
  it('loads scriptJsLoad into the editor for mode: jsLoad, and patches it back on save', async () => {
    const { wrapper, pageStore } = mountWithApp(PageScriptsDialog, {
      messages: MESSAGES,
      props: { mode: 'jsLoad' },
      stores: { page: { scriptJsLoad: 'console.log("original")' } }
    })
    await flushPromises()

    const textarea = wrapper.find('textarea')
    expect(textarea.element.value).toBe('console.log("original")')

    await textarea.setValue('console.log("edited")')
    await wrapper.find('button:has([data-icon="tabler:check"])').trigger('click')

    expect(pageStore.scriptJsLoad).toBe('console.log("edited")')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('loads scriptCss into the editor for mode: styles, and patches scriptCss (not scriptStyles) back on save', async () => {
    const { wrapper, pageStore } = mountWithApp(PageScriptsDialog, {
      messages: MESSAGES,
      props: { mode: 'styles' },
      stores: { page: { scriptCss: 'body { color: red }' } }
    })
    await flushPromises()

    const textarea = wrapper.find('textarea')
    expect(textarea.element.value).toBe('body { color: red }')

    await textarea.setValue('body { color: blue }')
    await wrapper.find('button:has([data-icon="tabler:check"])').trigger('click')

    expect(pageStore.scriptCss).toBe('body { color: blue }')
  })

  it('discarding closes without touching the store', async () => {
    const { wrapper, pageStore } = mountWithApp(PageScriptsDialog, {
      messages: MESSAGES,
      props: { mode: 'jsUnload' },
      stores: { page: { scriptJsUnload: 'console.log("kept")' } }
    })
    await flushPromises()

    await wrapper.find('textarea').setValue('console.log("discarded")')
    await wrapper.find('button:has([data-icon="tabler:x"])').trigger('click')

    expect(pageStore.scriptJsUnload).toBe('console.log("kept")')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
