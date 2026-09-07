import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WNotifications from './WNotifications.vue'
import { notify, queue } from '@/composables/notify'

import { createTestI18n } from '../../../test/i18n.js'

/*
 * `<w-notifications>` renders its stack through `<teleport to="body">`. Stubbing `teleport` (the
 * same convention `WDialog.test.js` uses) renders the content inline in the wrapper instead of into
 * `document.body`, which is all a plain `wrapper.find()` needs here.
 */
function mountStack() {
  return mount(WNotifications, {
    global: { plugins: [createTestI18n()], stubs: { teleport: true } }
  })
}

afterEach(() => {
  // -> `queue` is a module-level singleton shared by every notify() caller; clear it between tests
  queue.splice(0)
})

describe('WNotifications', () => {
  it('renders a pushed notification', () => {
    const wrapper = mountStack()

    notify.positive('Changes saved.')

    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.text()).toContain('Changes saved.')
    })
  })

  // -> `0` under Ledger (unchanged from before this task), a real value under Cobalt
  //    (`body.body--cobalt`, OpenProject #2767/#2772), matching "toasts ... take
  //    `--radius-control`"
  it('draws each toast off --radius-control, not left unrounded', async () => {
    const wrapper = mountStack()

    notify.info('Working on it.')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.w-notification').classes()).toContain('rounded-control')
  })
})
