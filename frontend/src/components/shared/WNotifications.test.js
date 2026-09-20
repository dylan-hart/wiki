import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WNotifications from './WNotifications.vue'
import { notify, queue } from '@/composables/notify'

import { createTestI18n } from '../../../test/i18n.js'

/* Teleport is stubbed so the stack renders inline in the wrapper, which `wrapper.find()` needs. */
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

  it('draws each toast off --radius-control, not left unrounded', async () => {
    const wrapper = mountStack()

    notify.info('Working on it.')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.w-notification').classes()).toContain('rounded-control')
  })

  // -> Anchored to the bottom so the stack cannot obscure the searchbar
  it('anchors the stack to the bottom of the viewport, not the top', () => {
    const wrapper = mountStack()

    const classes = wrapper.find('.w-notifications').classes()
    expect(classes).toContain('bottom-0')
    expect(classes).not.toContain('top-0')
  })

  /*
   * jsdom cannot reliably resolve a scoped `<style>` block's computed transform on a
   * Vue-transition-only class -- it is applied and removed within a single transition frame -- so
   * this asserts against the component's own source text instead.
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

  // -> `overflow-hidden` is what keeps the square-cornered timeout bar inside the rounded corners,
  //    so the repeat-count badge that deliberately overhangs the same corner must sit outside it.
  it('clips the timeout bar to the rounded corners without clipping the repeat-count badge', async () => {
    const wrapper = mountStack()

    notify.positive('Retrying.')
    notify.positive('Retrying.') // same message -> merges into one toast, bumping count to 2
    await wrapper.vm.$nextTick()

    const toast = wrapper.find('.w-notification')
    expect(toast.classes()).toContain('overflow-hidden')
    expect(toast.find('.w-notification-count').exists()).toBe(false)
    expect(wrapper.find('.w-notification-count').exists()).toBe(true)
  })
})
