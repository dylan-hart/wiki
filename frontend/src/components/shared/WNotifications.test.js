import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

  // -> OpenProject #3029: anchored to the top, the stack could obscure the searchbar. Anchoring to
  //    the bottom instead applies to both aesthetics identically, with no Ledger/Cobalt split.
  it('anchors the stack to the bottom of the viewport, not the top', () => {
    const wrapper = mountStack()

    const classes = wrapper.find('.w-notifications').classes()
    expect(classes).toContain('bottom-0')
    expect(classes).not.toContain('top-0')
  })

  /*
   * The enter/leave slide direction must match the bottom anchor -- a toast rises from the bottom
   * rather than dropping from the top. jsdom cannot reliably resolve a scoped `<style>` block's
   * computed transform on a Vue-transition-only class (it's applied and removed within a single
   * transition frame), so this asserts against the component's own source text instead, the same
   * way `WCard.test.js` checks a scoped-style declaration jsdom's cascade can't be trusted to run.
   */
  it('slides a toast up from the bottom on enter/leave, not down from the top', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'WNotifications.vue'),
      'utf-8'
    )

    expect(source).toMatch(
      /\.w-notification-enter-from,\s*\n\s*\.w-notification-leave-to\s*\{\s*\n\s*opacity:\s*0;\s*\n\s*transform:\s*translateY\(24px\);/
    )
  })
})
