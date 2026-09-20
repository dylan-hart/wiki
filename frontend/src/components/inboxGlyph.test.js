import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import HeaderActionsMenu from './HeaderActionsMenu.vue'
import HeaderNav from './HeaderNav.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * The two entry points are one affordance, not two: `HeaderNav.vue`'s badged button is what a wide
 * viewport shows, and `HeaderActionsMenu.vue`'s row is the same thing collapsed below 900px -- fix
 * one alone and the header's inbox glyph depends on window width. Asserted as an EQUALITY against
 * `InboxOverlay.vue` rather than against a hardcoded name, so whichever of the three moves next
 * drags the others with it instead of drifting silently.
 *
 * The destination's icon is read out of its source text rather than by mounting `InboxOverlay`:
 * that component statically imports `monaco-editor`, and the file-level `vi.mock` hoists mounting
 * it would need then apply to the two components this file actually exercises.
 */
const inboxOverlaySource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'InboxOverlay.vue'),
  'utf8'
)

/**
 * Matched non-greedily and within a bounded window, so a later sidenav entry's icon cannot be picked
 * up if the `watching` entry ever loses its own.
 */
function watchingSidenavIcon() {
  return inboxOverlaySource.match(/key: 'watching',[\s\S]{0,200}?icon: '([^']+)'/)?.[1]
}

/*
  `composables/screen.js` caches one ref per breakpoint at MODULE scope for the whole file, so
  `matchMedia` has to be stubbed wide BEFORE the first mount seeds that cache. Wide is what puts
  `HeaderNav` in its uncollapsed branch, the one that renders the button at all; nothing in this file
  needs the narrow branch.
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
