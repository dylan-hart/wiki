import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

/*
  The overlay statically imports `InboxReview.vue`, so its `monaco-editor` import runs whichever tab
  is showing. This suite is about the overlay shell, not the diff editor.
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
import InboxPages from '@/pages/InboxPages.vue'
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
    pendingReview: 'Pending Review',
    pages: 'My Pages'
  }
}

function mountInboxOverlay(overlayOpts) {
  return mountWithApp(InboxOverlay, {
    props: overlayOpts ? { overlayOpts } : {},
    messages,
    routes: ['/'],
    // -> Both tabs' content fetches off `siteStore.id` on mount; seeded so those calls take their
    //    real path instead of the "no site yet" guard clause.
    stores: { site: { id: 'site-1' } }
  })
}

describe('InboxOverlay sidenav', () => {
  it('renders exactly three rail entries', () => {
    const { wrapper } = mountInboxOverlay()

    const labels = wrapper.findAll('.inbox-overlay-sidebar .w-item-label').map((el) => el.text())
    expect(labels).toEqual(['Inbox', 'Pending Review', 'My Pages'])
  })

  it('opens onto the Pages tab when overlayOpts.tab is "pages"', () => {
    const { wrapper } = mountInboxOverlay({ tab: 'pages' })

    expect(wrapper.vm.tab).toBe('pages')
    expect(wrapper.findComponent(InboxPages).exists()).toBe(true)
    expect(wrapper.findComponent(InboxReview).exists()).toBe(false)
  })

  it('falls back to the Watching tab for an unknown overlayOpts.tab', () => {
    const { wrapper } = mountInboxOverlay({ tab: 'nonsense' })

    expect(wrapper.vm.tab).toBe('watching')
  })

  it('switches to the Pages tab on a rail click', async () => {
    const { wrapper } = mountInboxOverlay()

    const items = wrapper.findAll('.inbox-overlay-sidebar .w-item')
    await items[2].trigger('click')

    expect(wrapper.vm.tab).toBe('pages')
    expect(wrapper.findComponent(InboxPages).exists()).toBe(true)
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

/** `InboxReview` takes this state as props; it never reads it back off the store itself. */
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

/** `MainOverlayDialog`'s shared dialog is `persistent`, so Close is the one way out. */
describe('InboxOverlay close', () => {
  it('clears siteStore.overlay on Close', async () => {
    const { wrapper, siteStore } = mountInboxOverlay()
    siteStore.overlay = 'Inbox'

    await wrapper.find('[aria-label="Close"]').trigger('click')

    expect(siteStore.overlay).toBe('')
  })
})

/**
 * Asserted against the source text rather than a computed style: the DOM stand-in does not reliably
 * resolve a compound `.body--dark &` selector the way a real browser would.
 */
describe('InboxOverlay: dark mode', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
    'utf-8'
  )

  it('gives .inbox-overlay a background + color pairing for both themes', () => {
    const overlayRule = source.match(/\.inbox-overlay\s*\{[\s\S]*?\n\}\n/)[0]

    expect(overlayRule).toMatch(
      /\.body--light\s+&\s*\{[^}]*background-color:\s*var\(--color-surface\)/
    )
    expect(overlayRule).toMatch(/\.body--light\s+&\s*\{[^}]*color:\s*var\(--color-text-body\)/)
    expect(overlayRule).toMatch(
      /\.body--dark\s+&\s*\{[^}]*background-color:\s*var\(--color-dark-3\)/
    )
    expect(overlayRule).toMatch(/\.body--dark\s+&\s*\{[^}]*color:\s*var\(--color-text-dark\)/)
  })

  it('gives .inbox-overlay-sidebar its own themed background too, not just its nav item text', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /\.body--light\s+&\s*\{[^}]*background-color:\s*var\(--color-tint-alt\)/
    )
    expect(sidebarRule).toMatch(
      /\.body--dark\s+&\s*\{[^}]*background-color:\s*var\(--color-dark-4\)/
    )
  })
})

/**
 * Cobalt draws this rail as the site's own sidebar chrome and keeps it identical across the
 * light/dark toggle, so one `body--cobalt` block covers both and no `body--dark` variant is checked.
 */
describe('InboxOverlay: Cobalt aesthetic', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
    'utf-8'
  )

  it('gives .inbox-overlay-sidebar a Cobalt background + hairline off --color-sidebar', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /\.body--cobalt\s+&\s*\{[^}]*background-color:\s*var\(--color-sidebar\)/
    )
    expect(sidebarRule).toMatch(
      /\.body--cobalt\s+&\s*\{[^}]*border-inline-end-color:\s*var\(--color-sidebar-hairline\)/
    )
  })

  it('gives an inactive rail row Cobalt text + icon colour', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(/\.body--cobalt\s+&\s*\{[^}]*color:\s*var\(--color-sidebar-text\)/)
    expect(sidebarRule).toMatch(/var\(--color-sidebar-icon\)/)
  })

  it('gives the active rail row Cobalt’s pill shape -- radius, inset margin and inset-shadow accent, not a border', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /\.body--cobalt\s+&\s*\{[^}]*background-color:\s*var\(--color-sidebar-active-bg\)/
    )
    expect(sidebarRule).toMatch(/border-inline-start-color:\s*transparent/)
    expect(sidebarRule).toMatch(/border-radius:\s*var\(--radius-control\)/)
    expect(sidebarRule).toMatch(/box-shadow:\s*var\(--nav-active-inset\)/)
    expect(sidebarRule).toMatch(/margin-inline:\s*10px/)
  })

  it('gives the decline button whichever accent fill the aesthetic carries', () => {
    const negativeRule = source.match(/\.inbox-square-btn--negative\.w-btn\s*\{[\s\S]*?\n\}\n/)[0]

    /*
      One rule, not an aesthetic branch: `--color-accent-fill` already carries each aesthetic's own
      value. Ledger's dark theme lightens it and Cobalt's does not, so that override excludes Cobalt.
    */
    expect(negativeRule).toMatch(/border-color:\s*var\(--color-accent-fill\)/)
    expect(negativeRule).toMatch(
      /\.body--dark:not\(\.body--cobalt\)\s+&\s*\{[^}]*border-color:\s*var\(--color-accent-dark\)/
    )
  })
})
