import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminClassification from './AdminClassification.vue'

/**
 * OpenProject #1731: `createLevel()` posts and awaits with its trigger button live throughout --
 * unlike every other write on this page, nothing blocked a second click from firing a second
 * identical POST before the first round trip (and its `load()` refresh) completed.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        'admin.classification.title': 'Classification',
        'admin.classification.new': 'New Level',
        'admin.classification.newDefaultName': 'New Level'
      }
    }
  })

  return mount(AdminClassification, {
    global: {
      plugins: [i18n]
    }
  })
}

function findNewLevelButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().includes('New Level'))
}

/** Lets the page's own `onMounted(() => load())` round trip settle before a test drives it. */
async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('AdminClassification', () => {
  it('issues exactly one POST when the New Level button is clicked twice synchronously', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    // -> Never resolves within this test, so the first click's round trip is still in flight when
    //    the second click fires -- exactly the window the double-submit guard has to hold shut.
    API_CLIENT.post.mockReturnValue({ json: () => new Promise(() => {}) })

    const wrapper = mountPage()
    await flush(wrapper)

    const newLevelBtn = findNewLevelButton(wrapper)
    expect(newLevelBtn).toBeTruthy()

    // -> `trigger()` dispatches its DOM event synchronously before returning a `nextTick()` promise,
    //    so calling it twice before awaiting either dispatches both clicks back-to-back with no
    //    render cycle in between -- the guard has to hold on `state.isLoading` itself, not on the
    //    button's `disabled` attribute having had a chance to catch up.
    const firstClick = newLevelBtn.trigger('click')
    const secondClick = newLevelBtn.trigger('click')
    await firstClick
    await secondClick

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.state.isLoading).toBe(true)

    wrapper.unmount()
  })

  it('re-enables the button and lets a later click through again after a failed create', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network'))
    })

    const wrapper = mountPage()
    await flush(wrapper)

    await wrapper.vm.createLevel()
    expect(wrapper.vm.state.isLoading).toBe(false)

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'lvl-2' }) })
    await wrapper.vm.createLevel()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })
})
