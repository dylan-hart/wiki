import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WDialog from './WDialog.vue'

/**
 * OpenProject #1708: the scroll-lock watcher runs `{ immediate: true }` so it fires once at mount
 * for EVERY instance, including one that mounts already closed (`modelValue` defaults to `false`).
 * The immediate run took the else-branch -- the release path -- decrementing the shared
 * `wDialogDepth` counter and clearing `document.body.style.overflow` even though this instance
 * never incremented it. That is exactly what happens when `PagePropertiesDialog`'s two inline,
 * closed-by-default `<w-dialog>`s mount inside `SideDialog`'s already-open panel: each one takes
 * the shared depth from 1 to 0 and unlocks the page behind a dialog that is still on screen.
 *
 * The fix tracks a component-local `hasLocked` flag, set only by the watcher's open branch, so the
 * release path (both the watcher's else-branch and `onBeforeUnmount`) can only ever hand back a
 * lock this instance actually took.
 */

afterEach(() => {
  // -> The lock state lives on `document.body`, shared across every WDialog instance -- reset it
  //    between tests so one test's leftover depth/overflow can't leak into the next.
  delete document.body.dataset.wDialogDepth
  document.body.style.overflow = ''
})

describe('WDialog scroll-lock reference counting', () => {
  it('does not touch the lock when it mounts already closed', () => {
    mount(WDialog, { props: { modelValue: false } })

    expect(document.body.dataset.wDialogDepth).toBeUndefined()
    expect(document.body.style.overflow).toBe('')
  })

  it('takes the lock when it mounts already open', () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
  })

  it('keeps the lock held while a second, closed dialog mounts on top (the SideDialog shape)', async () => {
    // -> Simulates SideDialog: the panel host dialog is already open (depth 1) before
    //    PagePropertiesDialog's own closed-by-default inline dialogs mount inside it.
    const outer = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    const inner = mount(WDialog, { props: { modelValue: false } })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    inner.unmount()
    outer.unmount()
  })

  it('releases the lock exactly once when closed after being open, and a second close is a no-op', async () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    await wrapper.setProps({ modelValue: false })

    expect(document.body.dataset.wDialogDepth).toBe('0')
    expect(document.body.style.overflow).toBe('')

    // -> A stray extra `false` (no state change) must not decrement past zero via `hasLocked`
    //    already being cleared -- Math.max(0, ...) already guarded the arithmetic, but the flag is
    //    what stops the release branch from running again at all.
    await wrapper.setProps({ modelValue: false })
    expect(document.body.dataset.wDialogDepth).toBe('0')
  })

  it('releases exactly one level of a stacked lock on close, leaving the other dialog locked', async () => {
    const first = mount(WDialog, { props: { modelValue: true } })
    const second = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('2')

    await second.setProps({ modelValue: false })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    first.unmount()
  })

  it('releases the lock on unmount while open (route change / host teardown)', () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    wrapper.unmount()

    expect(document.body.dataset.wDialogDepth).toBe('0')
    expect(document.body.style.overflow).toBe('')
  })

  it('does not release the lock on unmount while closed', () => {
    const wrapper = mount(WDialog, { props: { modelValue: false } })
    expect(document.body.dataset.wDialogDepth).toBeUndefined()

    wrapper.unmount()

    expect(document.body.dataset.wDialogDepth).toBeUndefined()
    expect(document.body.style.overflow).toBe('')
  })
})
