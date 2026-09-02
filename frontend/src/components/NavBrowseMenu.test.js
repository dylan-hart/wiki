import { afterEach, describe, expect, it } from 'vitest'

import NavBrowseMenu from './NavBrowseMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #832 (upstream #1793, recurred as upstream discussion #7316): a raw i18n key
 * (`sidebar.root`) rendered literally -- "/ sidebar.root" -- at the top of the folder-browsing
 * sidebar instead of resolving through translation, while a reader browsed into a subfolder. Fixed
 * once upstream and then came back on its own years later, which is what makes it worth pinning down
 * with a test rather than trusting it stays fixed by inspection.
 *
 * `NavSidebar.vue` / `NavSidebarItem.vue` (the custom-menu tree renderer) are not where this risk
 * actually lives in this fork: `NavSidebarItem.vue` makes no `t()` call at all -- every `item.label`
 * it renders is already a resolved page/folder title or a hand-authored string, never an i18n key --
 * so there is no key-shaped value on that path that could ever leak through untranslated. This
 * component (`NavBrowseMenu.vue`, the "Browse" sidebar menu opened from `MainLayout.vue`'s
 * `common.sidebar.browse` button) is this fork's actual rewrite of the upstream folder-browsing
 * sidebar the original bug was filed against: it walks one folder level at a time exactly the way
 * the old bug's UI did, and now leftover locale key `common.sidebar.root` (vendored into every
 * `backend/locales/*.json` from upstream's own strings, "(root)" in `en.json`) sits unused in this
 * fork specifically BECAUSE the component was written to leave the root level's title blank
 * (`v-if="level.title"`) rather than render a "(root)" placeholder through it. That is the fix this
 * suite pins down: the root level must never fall back to rendering that leftover key, or any other
 * i18n key, as literal text -- here, and again after moving into a real subfolder, which is the
 * step the original bug actually fired on.
 */

const ROOT_LEVEL = {
  title: '',
  items: [
    { path: 'docs', title: 'Docs', isPage: false, isFolder: true },
    { path: 'about', title: 'About', isPage: true, isFolder: false, icon: null }
  ],
  truncated: false
}

const DOCS_LEVEL = {
  title: 'Docs',
  items: [{ path: 'docs/intro', title: 'Intro', isPage: true, isFolder: false, icon: null }],
  truncated: false
}

/**
 * Real strings (`backend/locales/en.json`), flat with literal dots exactly as the backend serves
 * them (`GET /locales/:code/strings`, wired up unchanged in `App.vue`'s `i18n.setLocaleMessage`) --
 * not a nested object. Deliberately does NOT include `common.sidebar.root`: that key is never
 * supposed to be asked for by this component (see the suite doc comment above), so leaving it out of
 * the bundle means a regression that started asking for it would render vue-i18n's own
 * missing-translation fallback -- the raw key string -- which is precisely what these assertions
 * watch for.
 */
const REAL_STRINGS = {
  'common.browse.upOneLevel': 'Up one level',
  'common.browse.openFolder': 'Open the {title} folder',
  'common.browse.empty': 'There is nothing here.',
  'common.browse.truncated': 'This folder holds more entries than can be listed here.',
  'common.browse.loadFailed': 'Failed to load the contents of this folder.'
}

/** Any i18n-key-shaped token (`common.browse.upOneLevel`, `common.sidebar.root`, ...) in rendered text. */
const RAW_KEY_PATTERN = /\b[a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*){2,}\b/

async function mountBrowseMenu({ folderPath = '' } = {}) {
  const router = await createTestRouter(['/:pathMatch(.*)*'])

  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve(folderPath ? DOCS_LEVEL : ROOT_LEVEL)
  })

  // -> Same mounting shape as `LocaleSelectorMenu.test.js`: this component's own root is `<w-menu>`
  //    (a hidden placeholder span plus a teleport), whose trigger is climbed from the mounted root's
  //    own PARENT (`WMenu.vue`'s `onMounted`) -- so it must be attached to a real, connected element
  //    for that climb to find anything, and the dispatched click below must land on that same element.
  const { wrapper } = mountWithApp(NavBrowseMenu, {
    attachTo: document.body,
    messages: REAL_STRINGS,
    router,
    stores: {
      site: { id: 'site-1' },
      page: (store) => {
        store.$patch({ path: folderPath ? `${folderPath}/current-page` : 'home', locale: 'en' })
      }
    }
  })

  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()

  return wrapper
}

/** Everything the (teleported) panel put on the page, independent of the wrapper's own subtree. */
function panelText() {
  return document.querySelector('.browse-menu-panel')?.textContent ?? ''
}

describe('NavBrowseMenu nav-root i18n leak (OpenProject #832)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('never renders a raw i18n key at the root level', async () => {
    await mountBrowseMenu()

    const text = panelText()
    expect(text).not.toContain('common.sidebar.root')
    expect(text).not.toMatch(RAW_KEY_PATTERN)
  })

  it('shows no title text at all for the root level -- blank, not a placeholder key', async () => {
    await mountBrowseMenu()

    // -> The title line only renders `v-if="level.title"`; the root's `title` is `''` (confirmed by
    //    `ROOT_LEVEL` above, matching what `GET tree/browse` actually returns for the site root --
    //    see its schema doc: "Empty at the site root, which is not a folder"), so the element itself
    //    must be absent rather than present-but-empty or present-with-a-key.
    expect(document.querySelector('.browse-menu-panel .truncate.text-sm.font-medium')).toBeNull()
  })

  it('resolves the up-one-level control through i18n, not as a raw key, once browsing a subfolder', async () => {
    const wrapper = await mountBrowseMenu({ folderPath: 'docs' })

    // -> This is the exact step the original bug fired on: browsing INTO a subfolder, where the
    //    upstream sidebar rendered "/ sidebar.root" instead of resolving its translated label.
    const upButton = document.querySelector('.browse-menu-up')
    expect(upButton).not.toBeNull()
    expect(upButton.getAttribute('aria-label')).toBe('Up one level')
    expect(upButton.getAttribute('aria-label')).not.toBe('common.browse.upOneLevel')

    const text = panelText()
    expect(text).not.toMatch(RAW_KEY_PATTERN)
    expect(text).toContain('Docs')

    wrapper.unmount()
  })

  it("shows the subfolder's own resolved title, never a raw key, next to the up-one-level control", async () => {
    await mountBrowseMenu({ folderPath: 'docs' })

    const titleEl = document.querySelector('.browse-menu-panel .truncate.text-sm.font-medium')
    expect(titleEl).not.toBeNull()
    expect(titleEl.textContent.trim()).toBe('Docs')
  })
})
