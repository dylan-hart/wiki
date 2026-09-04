import { describe, expect, it, vi } from 'vitest'

/*
  `InboxReview.vue` is a static import of this overlay's content (not lazily loaded, the way
  `MainOverlayDialog.vue` loads the overlay itself), so its own `monaco-editor` import runs no matter
  which tab is showing. Stubbed the same way `pages/InboxReview.test.js` does -- this suite is about
  the overlay shell (tab switching, Close, prop pass-through), not the diff editor.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createModel: vi.fn(() => ({ dispose: vi.fn(), getValue: vi.fn(() => '') })),
    createDiffEditor: vi.fn(() => ({ setModel: vi.fn(), dispose: vi.fn() }))
  }
}))

vi.mock('@/renderers/markdown', () => ({
  MarkdownRenderer: class {
    render() {
      return '<p></p>'
    }
  }
}))

import InboxOverlay from './InboxOverlay.vue'
import InboxReview from '@/pages/InboxReview.vue'
import { mountWithApp } from '../../test/mount.js'

const messages = {
  common: {
    actions: {
      close: 'Close'
    }
  },
  inbox: {
    title: 'Inbox',
    inbox: 'Inbox',
    pendingReview: 'Pending Review'
  }
}

function mountInboxOverlay(overlayOpts) {
  return mountWithApp(InboxOverlay, {
    props: overlayOpts ? { overlayOpts } : {},
    messages,
    routes: ['/'],
    // -> Both tabs' content components fetch off `siteStore.id` on mount (`InboxReview.vue`'s own
    //    `editorStore.fetchConfigs()` included) -- seeded so those calls take their real path
    //    instead of the "no site yet" guard clause, which is not what this suite is about.
    stores: { site: { id: 'site-1' } }
  })
}

/**
 * OpenProject #2531: the Inbox is now `MainOverlayDialog` content, switching between its two sections
 * with local reactive state (a plain `tab` ref) instead of `/_inbox/watching` / `/_inbox/review` child
 * routes -- `InboxLayout.vue` and its routes are deleted outright, no redirect shim.
 */
describe('InboxOverlay sidenav', () => {
  it('renders exactly two rail entries', () => {
    const { wrapper } = mountInboxOverlay()

    const labels = wrapper.findAll('.inbox-overlay-sidebar .w-item-label').map((el) => el.text())
    expect(labels).toEqual(['Inbox', 'Pending Review'])
  })

  it('defaults to the Watching tab with no overlayOpts', () => {
    const { wrapper } = mountInboxOverlay()

    expect(wrapper.vm.tab).toBe('watching')
  })

  it('opens onto the Review tab when overlayOpts.tab is "review"', () => {
    const { wrapper } = mountInboxOverlay({ tab: 'review' })

    expect(wrapper.vm.tab).toBe('review')
  })

  it('switches tabs locally on a rail click, with no router involved', async () => {
    const { wrapper, router } = mountInboxOverlay()
    const pushSpy = vi.spyOn(router, 'push')

    const items = wrapper.findAll('.inbox-overlay-sidebar .w-item')
    await items[1].trigger('click')

    expect(wrapper.vm.tab).toBe('review')
    expect(pushSpy).not.toHaveBeenCalled()
  })
})

/**
 * OpenProject #2530/#2531: `overlayOpts.submissionId`/`overlayOpts.from` are `InboxReview`'s own
 * initial state (set by `PageHeader.vue`'s `reviewSubmission()`), forwarded straight through as the
 * `initial-submission-id`/`from-page` props -- not read a second time off the store inside
 * `InboxReview` itself.
 */
describe('InboxOverlay overlayOpts pass-through to InboxReview', () => {
  it('passes submissionId/from down as initialSubmissionId/fromPage', () => {
    const { wrapper } = mountInboxOverlay({
      tab: 'review',
      submissionId: 'sub-1',
      from: 'page'
    })

    const review = wrapper.findComponent(InboxReview)
    expect(review.exists()).toBe(true)
    expect(review.props('initialSubmissionId')).toBe('sub-1')
    expect(review.props('fromPage')).toBe(true)
  })
})

/**
 * OpenProject #2531: Close is the one way out now that `MainOverlayDialog`'s shared `w-dialog` is
 * `persistent` (Escape/backdrop no longer dismiss it, unlike the old bespoke `WDialog` this replaces)
 * -- it clears `siteStore.overlay`, the same convention every other overlay's Close button uses.
 */
describe('InboxOverlay close', () => {
  it('clears siteStore.overlay on Close', async () => {
    const { wrapper, siteStore } = mountInboxOverlay()
    siteStore.overlay = 'Inbox'

    await wrapper.find('[aria-label="Close"]').trigger('click')

    expect(siteStore.overlay).toBe('')
  })
})
