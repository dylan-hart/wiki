import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// -> `PageActionsCol.vue` imports `browser-fs-access` at module scope, so the module graph needs a
//    stand-in even in the shards that never assert on `fileSave` -- only `PageActionsCol.export`
//    reads its calls.
vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

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

/**
 * OpenProject #2618: the rail's primary button opens Page Properties -- contents, tags, ratings,
 * comments -- and the Cardinal design draws it as a tag, not the pencil the second pass left there.
 * Pinned here because the glyph is a bare attribute with nothing else depending on it, which is
 * exactly the kind of thing that drifts back silently.
 *
 * Asserted through `data-icon` on the rendered element, which `WIcon.vue` carries on every branch
 * for this reason -- an inline <svg> is otherwise anonymous. `svg` rather than `iconify-icon` is
 * the second half of the claim: `tabler:tag` has to be in the committed
 * `src/assets/icons.generated.js` bundle (`npm run icons`), or WIcon falls through to a runtime
 * `/_icons` fetch instead of drawing it inline like every other chrome glyph.
 */
describe('PageActionsCol Page Properties glyph (#2618)', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('draws tabler:tag, inlined from the icon bundle', async () => {
    ;({ wrapper } = await mountRailWithPageActions())

    const button = wrapper.get('[aria-label="pageActions.pageProperties"]')
    const icon = button.get('.w-icon')

    expect(icon.attributes('data-icon')).toBe('tabler:tag')
    expect(icon.element.tagName.toLowerCase()).toBe('svg')
    expect(button.find('[data-icon="tabler:pencil"]').exists()).toBe(false)
  })
})
