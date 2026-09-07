import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { queue as notifyQueue } from '@/composables/notify'
import { copyToClipboard } from '@/helpers/clipboard'

import { mountRailWithCopyContent } from './pageActionsHarness.js'

vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
}))

/**
 * OpenProject #2795: the standalone "Copy Page Content" rail button, next to Export. Fetches the
 * same `format=markdown` export endpoint the Export menu's Markdown item uses, but hands the result
 * to `copyToClipboard()` instead of `fileSave()`.
 */
describe('PageActionsCol copy page content', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
    copyToClipboard.mockClear()
    copyToClipboard.mockResolvedValue(undefined)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('is offered when the reader holds read:source', async () => {
    ;({ wrapper } = await mountRailWithCopyContent())

    expect(wrapper.find('[aria-label="pageActions.copyPageContent"]').exists()).toBe(true)
  })

  it('is hidden without read:source', async () => {
    ;({ wrapper } = await mountRailWithCopyContent({ permissions: [] }))

    expect(wrapper.find('[aria-label="pageActions.copyPageContent"]').exists()).toBe(false)
  })

  it('is hidden entirely on a redirect page, along with the rest of the text-content block', async () => {
    ;({ wrapper } = await mountRailWithCopyContent({ editor: 'redirect' }))

    expect(wrapper.find('[aria-label="pageActions.copyPageContent"]').exists()).toBe(false)
  })

  it('fetches the raw markdown export and copies it to the clipboard, with a success toast', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithCopyContent())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })

    await wrapper.get('[aria-label="pageActions.copyPageContent"]').trigger('click')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export`,
      { searchParams: { format: 'markdown' } }
    )
    expect(copyToClipboard).toHaveBeenCalledWith('# Hello')
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Page content copied to the clipboard.'
    })
  })

  it('shows a negative toast with the error caption when the clipboard write fails', async () => {
    ;({ wrapper } = await mountRailWithCopyContent())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })
    copyToClipboard.mockRejectedValueOnce(new Error('Permission denied'))

    await wrapper.get('[aria-label="pageActions.copyPageContent"]').trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to copy the page content to the clipboard.',
      caption: 'Permission denied'
    })
  })

  it('shows a negative toast with the error caption when the export fetch fails', async () => {
    ;({ wrapper } = await mountRailWithCopyContent())
    API_CLIENT.get.mockReturnValueOnce({
      text: vi.fn().mockRejectedValue(new Error('network error'))
    })

    await wrapper.get('[aria-label="pageActions.copyPageContent"]').trigger('click')
    await flushPromises()

    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to copy the page content to the clipboard.',
      caption: 'network error'
    })
  })
})
