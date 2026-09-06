import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import HeaderActionsMenu from './HeaderActionsMenu.vue'
import HeaderNav from './HeaderNav.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2619: "the inbox affordance draws the glyph of the thing it opens" is one rule held
 * in three files with nothing enforcing it, and it broke exactly the way that predicts --
 * `InboxOverlay` moved its own header icon and its `watching` sidenav entry to `tabler:inbox`, while
 * both entry points into it stayed on `tabler:bell`, each with a comment still asserting the
 * agreement they had just lost.
 *
 * The two entry points are one affordance, not two: `HeaderNav.vue`'s badged button is what a wide
 * viewport shows, and `HeaderActionsMenu.vue`'s row is the same thing collapsed below 900px. Fixing
 * only the button would have made the header's inbox glyph depend on window width.
 *
 * Written as one `describe.each` over both rather than a copy in each component's own suite, per the
 * cross-component convention (`editorMarkupShared.test.js`, `apiKeyScopeTree.test.js`) -- and
 * asserted as an EQUALITY against `InboxOverlay.vue` rather than against a hardcoded name, so
 * whichever of the three moves next drags the others with it instead of drifting silently again.
 *
 * The destination's icon is read out of its source text rather than by mounting `InboxOverlay`:
 * that component statically imports `InboxReview.vue` and therefore `monaco-editor`, so mounting it
 * needs file-level `vi.mock` hoists (see `InboxOverlay.test.js`'s own header) that would then apply
 * to the two components this file actually exercises. `InboxOverlay.test.js`'s own dark-mode
 * describe reads its source the same way.
 */
const inboxOverlaySource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
  'utf8'
)

/**
 * The `watching` entry of `InboxOverlay.vue`'s `sidenav` computed -- the exact tab both entry points
 * open onto (`overlayOpts: { tab: 'watching' }`). Matched non-greedily and within a bounded window
 * so a later entry's icon cannot be picked up if this one ever loses its own.
 */
function watchingSidenavIcon() {
  return inboxOverlaySource.match(/key: 'watching',[\s\S]{0,200}?icon: '([^']+)'/)?.[1]
}

/*
  `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and `composables/screen.js` caches one
  ref per breakpoint at MODULE scope for the whole file -- so this has to be stubbed wide BEFORE the
  first mount seeds that cache, which is what puts `HeaderNav` in its uncollapsed branch (the one
  that renders the button at all) rather than handing off to `HeaderActionsMenu`. Nothing in this
  file needs the narrow branch, so a single wide stub is enough; `HeaderNav.test.js` documents the
  harder case where one file wants both.
*/
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})

const messages = {
  inbox: { title: 'Inbox' },
  common: {
    header: {
      profile: 'Profile',
      logout: 'Log Out',
      moreActions: 'More actions',
      createNewPage: 'Create New Page'
    }
  }
}

/**
 * Each case resolves the one `<w-icon>` its component draws for the inbox affordance. `HeaderNav`'s
 * is inside the badged button; `HeaderActionsMenu`'s is the avatar section of the row labelled with
 * the same `inbox.title` string, reached by opening the menu first (a plain DOM click on the trigger
 * -- see `HeaderActionsMenu.test.js` for why that is enough).
 */
const entryPoints = [
  {
    name: 'HeaderNav (wide viewport, the badged header button)',
    async iconNames() {
      const { wrapper } = mountWithApp(HeaderNav, {
        messages,
        routes: ['/'],
        stores: { user: (store) => store.$patch({ authenticated: true }) },
        stubs: { AccountMenu: true, NewMenu: true, HeaderActionsMenu: true, HeaderSearch: true }
      })
      await wrapper.vm.$nextTick()

      const button = wrapper.find('[aria-label="Inbox"]')
      expect(button.exists()).toBe(true)

      return button.findAll('[data-icon]').map((el) => el.attributes('data-icon'))
    }
  },
  {
    name: 'HeaderActionsMenu (collapsed below 900px, the overflow row)',
    async iconNames() {
      const { wrapper } = mountWithApp(HeaderActionsMenu, {
        messages,
        routes: ['/'],
        stores: { user: (store) => store.$patch({ authenticated: true }) }
      })
      await wrapper.find('[aria-label="More actions"]').trigger('click')

      const row = wrapper.findAll('.w-item').find((item) => item.text() === 'Inbox')
      expect(row).toBeTruthy()

      return row.findAll('[data-icon]').map((el) => el.attributes('data-icon'))
    }
  }
]

describe.each(entryPoints)(
  'inbox entry point glyph matches its destination (OpenProject #2619): $name',
  ({ iconNames }) => {
    it("draws InboxOverlay's own Watching-tab glyph", async () => {
      const watchingIcon = watchingSidenavIcon()
      expect(
        watchingIcon,
        "InboxOverlay's watching sidenav entry no longer declares an icon"
      ).toBeTruthy()

      expect(await iconNames()).toContain(watchingIcon)
    })
  }
)
