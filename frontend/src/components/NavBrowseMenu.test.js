import { afterEach, describe, expect, it } from 'vitest'

import NavBrowseMenu from './NavBrowseMenu.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The root level must never render an i18n key as literal text -- here, or after descending into a
 * subfolder, which is the step upstream's own version of this bug (requarks/wiki#1793) fired on. The
 * root's title is deliberately left blank (`v-if="level.title"`) rather than drawn through the
 * leftover `common.sidebar.root` placeholder the locale bundles still carry, so that key is never
 * asked for at all.
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
 * Flat with literal dots, exactly as the backend serves them -- not a nested object. Deliberately
 * omits `common.sidebar.root`, so a regression that started asking for it would render vue-i18n's
 * missing-translation fallback, the raw key string, which is what these assertions watch for.
 */
const REAL_STRINGS = {
  'common.browse.upOneLevel': 'Up one level',
  'common.browse.openFolder': 'Open the {title} folder',
  'common.browse.empty': 'There is nothing here.',
  'common.browse.truncated': 'This folder holds more entries than can be listed here.',
  'common.browse.loadFailed': 'Failed to load the contents of this folder.'
}

/** Any i18n-key-shaped token (`a.b.c`) in rendered text. */
const RAW_KEY_PATTERN = /\b[a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*){2,}\b/

async function mountBrowseMenu({ folderPath = '' } = {}) {
  const router = await createTestRouter(['/:pathMatch(.*)*'])

  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve(folderPath ? DOCS_LEVEL : ROOT_LEVEL)
  })

  // -> `WMenu` climbs to the mounted root's own PARENT to find its trigger, so this must be attached
  //    to a real, connected element and the dispatched click below must land on that same element.
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

/** The panel is teleported, so it is read off the document rather than the wrapper's own subtree. */
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

    // -> `GET tree/browse` returns an empty title for the site root, so the element must be absent
    //    rather than present-but-empty or present-with-a-key.
    expect(document.querySelector('.browse-menu-panel .truncate.text-sm.font-medium')).toBeNull()
  })

  it('resolves the up-one-level control through i18n, not as a raw key, once browsing a subfolder', async () => {
    const wrapper = await mountBrowseMenu({ folderPath: 'docs' })

    const upButton = document.querySelector('.up-one-level-btn')
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
