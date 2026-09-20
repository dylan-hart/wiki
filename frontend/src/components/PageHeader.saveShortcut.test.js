import { afterEach, describe, expect, it, vi } from 'vitest'

import PageHeader from './PageHeader.vue'
import { openDialogs } from '@/composables/dialog'
import { queue } from '@/composables/notify'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

async function mountHeader({ mode = 'edit', pending = true, active = true, reason = 'off' } = {}) {
  const router = await createTestRouter(['/'])
  const mounted = mountWithApp(PageHeader, {
    router,
    stores: {
      editor: {
        isActive: active,
        editor: 'markdown',
        mode,
        lastSaveTimestamp: 1,
        lastChangeTimestamp: pending ? 2 : 1
      },
      page: { editor: 'markdown' },
      user: { authenticated: true },
      site: (site) => {
        site.features.reasonForChange = reason
      }
    }
  })
  mounted.pageStore.pageSave = vi.fn().mockResolvedValue({})
  mounted.pageStore.pageSubmitSuggestion = vi.fn().mockResolvedValue({})
  mounted.pageStore.pageLoad = vi.fn().mockResolvedValue({})
  return mounted
}

function press(init = {}) {
  const ev = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init
  })
  window.dispatchEvent(ev)
  return ev
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PageHeader Ctrl/Cmd+S', () => {
  afterEach(() => {
    openDialogs.splice(0, openDialogs.length)
    queue.splice(0, queue.length)
  })

  it('runs the header save flow on Ctrl+S and swallows the browser save dialog', async () => {
    const { wrapper, pageStore } = await mountHeader()

    const ev = press()
    await settle()

    expect(ev.defaultPrevented).toBe(true)
    expect(pageStore.pageSave).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('treats Cmd+S the same', async () => {
    const { wrapper, pageStore } = await mountHeader()

    press({ ctrlKey: false, metaKey: true })
    await settle()

    expect(pageStore.pageSave).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('goes through the reason-for-change dialog rather than a bare pageSave()', async () => {
    const { wrapper, pageStore } = await mountHeader({ reason: 'required' })

    press()
    await settle()

    expect(openDialogs).toHaveLength(1)
    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not stack a second dialog when pressed again while one is open', async () => {
    const { wrapper } = await mountHeader({ reason: 'required' })

    press()
    await settle()
    press()
    await settle()

    expect(openDialogs).toHaveLength(1)
    wrapper.unmount()
  })

  it('still swallows the key but saves nothing when there are no pending changes', async () => {
    const { wrapper, pageStore } = await mountHeader({ pending: false })

    const ev = press()
    await settle()

    expect(ev.defaultPrevented).toBe(true)
    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('submits the suggestion in suggest mode, as the header button does', async () => {
    const { wrapper, pageStore } = await mountHeader({ mode: 'suggest' })

    press()
    await settle()

    expect(pageStore.pageSubmitSuggestion).toHaveBeenCalledTimes(1)
    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('leaves the key alone when no editor is open', async () => {
    const { wrapper, pageStore } = await mountHeader({ active: false })

    const ev = press()
    await settle()

    expect(ev.defaultPrevented).toBe(false)
    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores a keydown an editor binding already handled', async () => {
    const { wrapper, pageStore } = await mountHeader()

    const ev = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      cancelable: true
    })
    ev.preventDefault()
    window.dispatchEvent(ev)
    await settle()

    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores an unmodified s and Ctrl+Shift+S', async () => {
    const { wrapper, pageStore } = await mountHeader()

    press({ ctrlKey: false })
    press({ shiftKey: true })
    await settle()

    expect(pageStore.pageSave).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('saves once when an editor emits the bus event', async () => {
    const { wrapper, pageStore } = await mountHeader()

    EVENT_BUS.emit('saveShortcut')
    await settle()

    expect(pageStore.pageSave).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('stops listening once the header unmounts', async () => {
    const { wrapper, pageStore } = await mountHeader()
    wrapper.unmount()

    const ev = press()
    EVENT_BUS.emit('saveShortcut')
    await settle()

    expect(ev.defaultPrevented).toBe(false)
    expect(pageStore.pageSave).not.toHaveBeenCalled()
  })
})
