import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import PageScriptsDialog from './PageScriptsDialog.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
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
  }
})

/**
 * Regression coverage for OpenProject #1130: the mode-to-store-key mapping used to be derived by
 * capitalizing `props.mode` (`'script' + 'Styles'` = `scriptStyles`), which happened to land on the
 * real field for `jsLoad`/`jsUnload` but not for `styles`, whose actual pageStore field is
 * `scriptCss`. Each mode is exercised the same way: mount already showing whatever the store holds,
 * type something new, save, and assert the ONE matching store field changed and nothing else did.
 */
describe('PageScriptsDialog', () => {
  function mountDialog(mode) {
    setActivePinia(createPinia())
    const pageStore = usePageStore()
    pageStore.scriptJsLoad = 'console.log("load")'
    pageStore.scriptJsUnload = 'console.log("unload")'
    pageStore.scriptCss = 'body { color: red; }'
    useSiteStore()

    const wrapper = mount(PageScriptsDialog, {
      props: { mode },
      global: { plugins: [i18n] }
    })
    return { wrapper, pageStore }
  }

  const cases = [
    { mode: 'jsLoad', storeKey: 'scriptJsLoad' },
    { mode: 'jsUnload', storeKey: 'scriptJsUnload' },
    { mode: 'styles', storeKey: 'scriptCss' }
  ]

  for (const { mode, storeKey } of cases) {
    it(`reads the existing ${storeKey} content into the editor for mode "${mode}"`, async () => {
      const { wrapper, pageStore } = mountDialog(mode)
      // -> `onMounted` sets `state.content` after the first render, so the textarea's `:value`
      //    binding only reflects it once Vue's own scheduled re-render has flushed
      await nextTick()

      expect(wrapper.find('textarea').element.value).toBe(pageStore[storeKey])
    })

    it(`writes only ${storeKey} back to the store on save for mode "${mode}"`, async () => {
      const { wrapper, pageStore } = mountDialog(mode)
      const before = { ...pageStore.$state }

      await wrapper.find('textarea').setValue('/* updated */')
      // -> `saveAndClose` is bound to the Save button's click; triggering the button directly (it's
      //    the last of the two card-action buttons, Discard then Save) keeps this test exercising
      //    the real handler wiring rather than calling the method in isolation
      const buttons = wrapper.findAll('button')
      await buttons[buttons.length - 1].trigger('click')

      expect(pageStore[storeKey]).toBe('/* updated */')
      for (const key of Object.keys(before)) {
        if (key === storeKey) {
          continue
        }
        expect(pageStore[key]).toEqual(before[key])
      }
      expect(wrapper.emitted('close')).toBeTruthy()
    })
  }
})
