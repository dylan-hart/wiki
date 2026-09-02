import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import { useFlagsStore } from '@/stores/flags'
import { queue as notifyQueue } from '@/composables/notify'
import { mountRailWithHistory, mountRailWithPageActions } from './pageActionsHarness.js'

describe('PageActionsCol Page Data removal (#1911)', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('never renders a Page Data button, even with the experimental flag on', async () => {
    ;({ wrapper } = await mountRailWithPageActions())
    const flagsStore = useFlagsStore()
    flagsStore.experimental = true
    await flushPromises()

    expect(wrapper.find('[aria-label="Page Data"]').exists()).toBe(false)
  })
})

describe('PageActionsCol page history button', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('opens the History overlay when the page has been saved', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: 'page-1' }))

    await wrapper.get('[aria-label="pageActions.pageHistory"]').trigger('click')

    expect(ctx.siteStore.overlay).toBe('PageHistory')
    expect(notifyQueue).toHaveLength(0)
  })

  it('notifies instead of opening the overlay for an unsaved page with no id', async () => {
    let ctx
    // -> '' is the store's real default (page.js), not a stand-in like `null` -- a never-saved page
    //    has literally never been assigned an id
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: '', creating: true }))

    await wrapper.get('[aria-label="pageActions.pageHistory"]').trigger('click')

    expect(ctx.siteStore.overlay).toBeNull()
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'info' })
  })
})
