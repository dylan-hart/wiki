import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WDialog from './WDialog.vue'

/*
  `<w-dialog>` renders its panel through `<teleport to="body">` (see `WDialog.vue`), which is exactly
  what makes `document.getElementById('app')` -- not some ancestor of the `<w-dialog>` component
  instance -- the only element `inert` can land on and still work: the panel itself ends up as a
  sibling of `#app`, not a descendant, once teleported. Stubbing `teleport` (same convention every
  other `WDialog` consumer test in this workspace uses, e.g. `PageDeleteDialog.test.js`) is fine here
  because what's under test is the side effect on `document`/`#app`, not the teleported markup itself.
*/
function mountDialog(props = {}) {
  return mount(WDialog, {
    props: { modelValue: false, ...props },
    global: { stubs: { teleport: true } }
  })
}

function appendAppRoot() {
  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)
  return appRoot
}

describe('WDialog', () => {
  let appRoot

  beforeEach(() => {
    appRoot = appendAppRoot()
  })

  afterEach(() => {
    appRoot.remove()
    delete document.body.dataset.wDialogDepth
    document.body.style.overflow = ''
    document.body.removeAttribute('inert')
  })

  it("sets inert on the app root while open, and never on body (the panel's real teleported ancestor)", async () => {
    const wrapper = mountDialog({ modelValue: true })
    await flushPromises()

    expect(appRoot.hasAttribute('inert')).toBe(true)
    expect(document.body.hasAttribute('inert')).toBe(false)

    wrapper.unmount()
  })

  it('does not set inert while closed', async () => {
    const wrapper = mountDialog({ modelValue: false })
    await flushPromises()

    expect(appRoot.hasAttribute('inert')).toBe(false)

    wrapper.unmount()
  })

  it('stays inert while a second dialog opens and closes on top of the first', async () => {
    const first = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    const second = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    await second.setProps({ modelValue: false })
    await flushPromises()
    // -> First dialog is still open, so the background must stay inert
    expect(appRoot.hasAttribute('inert')).toBe(true)

    first.unmount()
    second.unmount()
  })

  it('removes inert only when the last dialog closes', async () => {
    const first = mountDialog({ modelValue: true })
    await flushPromises()
    const second = mountDialog({ modelValue: true })
    await flushPromises()

    await second.setProps({ modelValue: false })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    await first.setProps({ modelValue: false })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(false)

    first.unmount()
    second.unmount()
  })

  it('removes inert on unmount, mirroring the existing scroll-lock cleanup', async () => {
    const wrapper = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    // -> Unmounted while still open, e.g. a route change or host teardown
    wrapper.unmount()

    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(document.body.dataset.wDialogDepth).toBe('0')
  })
})
