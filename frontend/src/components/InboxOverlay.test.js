import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * OpenProject #2543 follow-up: `.inbox-overlay` (the `w-layout` wrapping this whole overlay) is a
 * plain div, not a `WCard` -- the one component that declares both halves of a surface itself (see
 * `.w-card`'s own `body.body--dark` rule in `tailwind.css`) -- so without an explicit `color` here
 * every label under `InboxWatching.vue`/`InboxReview.vue` (notifications, watched pages, watch
 * preferences) inherited the document's default black text: readable in light mode by accident,
 * illegible against this overlay's own dark background in dark mode.
 *
 * Asserted against the source text rather than a computed style -- jsdom's CSS engine does not
 * reliably resolve a compound `@at-root .body--dark &` selector the way a real browser would, the
 * same reasoning `WelcomeOverlay.test.js`'s equivalent dark-mode fix documents.
 */
describe('InboxOverlay: dark mode', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
    'utf-8'
  )

  /*
   * OpenProject #2778: these used to read the `$surface`/`$text-body`/`$dark-3`/`$text-dark` SCSS
   * literals -- Ledger-only constants (`css/_theme.scss`'s own header says so) that never pick up
   * Cobalt's `body.body--cobalt`/`body.body--cobalt.body--dark` overrides. Moved onto the matching
   * `var(--color-*)` custom properties, which resolve to the identical Ledger values (this assertion
   * still passes unchanged there) and to Cobalt's own values once `body--cobalt` is on `<body>`.
   */
  it('gives .inbox-overlay a background + color pairing for both themes', () => {
    const overlayRule = source.match(/\.inbox-overlay\s*\{[\s\S]*?\n\}\n/)[0]

    expect(overlayRule).toMatch(
      /@at-root\s+\.body--light\s+&\s*\{[^}]*background-color:\s*var\(--color-surface\)/
    )
    expect(overlayRule).toMatch(
      /@at-root\s+\.body--light\s+&\s*\{[^}]*color:\s*var\(--color-text-body\)/
    )
    expect(overlayRule).toMatch(
      /@at-root\s+\.body--dark\s+&\s*\{[^}]*background-color:\s*var\(--color-dark-3\)/
    )
    expect(overlayRule).toMatch(
      /@at-root\s+\.body--dark\s+&\s*\{[^}]*color:\s*var\(--color-text-dark\)/
    )
  })

  it('gives .inbox-overlay-sidebar its own themed background too, not just its nav item text', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--light\s+&\s*\{[^}]*background-color:\s*var\(--color-tint-alt\)/
    )
    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--dark\s+&\s*\{[^}]*background-color:\s*var\(--color-dark-4\)/
    )
  })
})

/**
 * OpenProject #2778: diffed against `Cardinal Wiki - Inbox 3x - Cobalt.dc.html`. Cobalt draws this
 * rail as the site's own sidebar chrome (same tokens `NavItemEditor.vue`'s Cobalt active row already
 * uses for the identical role) rather than a light/dark-following tint, and stays the same across the
 * light/dark toggle -- one `body--cobalt` block covers both, so these assertions don't need a
 * `body--dark` variant the way the Ledger ones above do.
 */
describe('InboxOverlay: Cobalt aesthetic', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
    'utf-8'
  )

  it('gives .inbox-overlay-sidebar a Cobalt background + hairline off --color-sidebar', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--cobalt\s+&\s*\{[^}]*background-color:\s*var\(--color-sidebar\)/
    )
    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--cobalt\s+&\s*\{[^}]*border-inline-end-color:\s*var\(--color-sidebar-hairline\)/
    )
  })

  it('gives an inactive rail row Cobalt text + icon colour', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--cobalt\s+&\s*\{[^}]*color:\s*var\(--color-sidebar-text\)/
    )
    expect(sidebarRule).toMatch(/var\(--color-sidebar-icon\)/)
  })

  it('gives the active rail row Cobalt’s pill shape -- radius, inset margin and inset-shadow accent, not a border', () => {
    const sidebarRule = source.match(/\.inbox-overlay-sidebar\s*\{[\s\S]*?\n\}\n\n\/\*/)[0]

    expect(sidebarRule).toMatch(
      /@at-root\s+\.body--cobalt\s+&\s*\{[^}]*background-color:\s*var\(--color-sidebar-active-bg\)/
    )
    expect(sidebarRule).toMatch(/border-inline-start-color:\s*transparent/)
    expect(sidebarRule).toMatch(/border-radius:\s*var\(--radius-control\)/)
    expect(sidebarRule).toMatch(/box-shadow:\s*var\(--nav-active-inset\)/)
    expect(sidebarRule).toMatch(/margin-inline:\s*10px/)
  })

  it('gives the decline button whichever accent fill the aesthetic carries', () => {
    const negativeRule = source.match(/\.inbox-square-btn--negative\.w-btn\s*\{[\s\S]*?\n\}\n/)[0]

    /*
      One rule, not an aesthetic branch: `--color-accent-fill` is `#e4676b` under Ledger and
      `#ff4d5a` under Cobalt, which is the whole of the difference between the two mockups here.
      Ledger's dark theme lightens it; Cobalt's does not, so that override excludes the aesthetic.
    */
    expect(negativeRule).toMatch(/border-color:\s*var\(--color-accent-fill\)/)
    expect(negativeRule).toMatch(
      /@at-root\s+\.body--dark:not\(\.body--cobalt\)\s+&\s*\{[^}]*border-color:\s*var\(--color-accent-dark\)/
    )
  })
})
