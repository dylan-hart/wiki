import { afterEach, describe, expect, it, vi } from 'vitest'
import HeaderSearch from './HeaderSearch.vue'
import { copyToClipboard } from '@/helpers/clipboard'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn()
}))

/**
 * Regression test for the `popularTags` computed (not part of the backend `FIXME:` list this branch's
 * test infra otherwise regression-tests — see CLAUDE.md's "Testing (backend)" section — this is the
 * fifth, frontend bug the epic separately tracks). It must sort by usage count DESCENDING, most-used
 * first: `orderBy(siteStore.tags, ['usageCount', 'desc'], ['asc', 'asc'])` passed the string `'desc'`
 * as a second sort KEY (es-toolkit's `orderBy(collection, iteratees[], orders[])` has no such
 * property on a tag) rather than as the ORDER for `usageCount`, so every tag sorted ascending by
 * usage — the opposite of "popular" — regardless of what order strings were written after it.
 */
async function mountWithTags(tags) {
  const router = await createTestRouter(['/'])

  const { wrapper } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.features.search = true
        store.tagsLoaded = true
        store.tags = tags
      }
    }
  })

  // -> The panel (and the popular-tags list inside it) only renders once the field is focused --
  //    mirrors what a real user does, rather than reaching into component internals for the flag.
  await wrapper.find('.header-search-input').trigger('focus')

  return wrapper
}

/**
 * OpenProject #987, #1120, #1218: the browse-by-tags entry point, moved here from `HeaderNav.vue`
 * (`HeaderNav.test.js` asserts it no longer renders one of its own) so it can dock flush against the
 * search field's right edge, matching the 2.5.x reference layout -- `la:tags` rather than the
 * previous `la:hashtag`, which read as a `#` operator glyph rather than a tag shape.
 */
describe('HeaderSearch "Browse by tags" entry point (OpenProject #1218)', () => {
  it('renders a link to /_tags docked against the field, unconditionally', async () => {
    const wrapper = await mountWithTags([])

    const tagsLink = wrapper.find('.header-search-tags-btn')
    expect(tagsLink.exists()).toBe(true)
    expect(tagsLink.attributes('href')).toBe('/_tags')
  })

  it('uses the la:tags icon, not la:hashtag', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-tags-btn [data-icon]').attributes('data-icon')).toBe(
      'la:tags'
    )
  })

  it('does not render in row (phone) form, which has no room to dock a second control', async () => {
    const router = await createTestRouter(['/'])

    const { wrapper } = mountWithApp(HeaderSearch, {
      props: { row: true },
      router,
      stores: {
        site: (store) => {
          store.features.search = true
        }
      }
    })

    expect(wrapper.find('.header-search-tags-btn').exists()).toBe(false)
  })
})

/**
 * OpenProject #2050: `handleKeyPress` only ever tested `ev.ctrlKey`, so Cmd+K did nothing on macOS --
 * worse, Ctrl+K there is the OS's own emacs kill-to-end-of-line binding, already claimed. These
 * assert both modifiers now focus the field, and that the hint (previously hardcoded, always
 * "Ctrl+K") follows a stubbed `navigator.platform`.
 */
describe('HeaderSearch keyboard shortcut (OpenProject #2050)', () => {
  let activeWrapper = null

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.restoreAllMocks()
  })

  async function mountAttached() {
    const router = await createTestRouter(['/'])

    const { wrapper } = mountWithApp(HeaderSearch, {
      attachTo: document.body,
      router,
      stores: {
        site: (store) => {
          store.features.search = true
        }
      }
    })
    activeWrapper = wrapper
    return wrapper
  }

  it('focuses the field on Ctrl+K', async () => {
    const wrapper = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('also focuses the field on Cmd+K (metaKey) -- previously unbound entirely', async () => {
    const wrapper = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('marks the field aria-keyshortcuts for both modifiers', async () => {
    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-input').attributes('aria-keyshortcuts')).toBe(
      'Meta+K Control+K'
    )
  })

  it('renders the Ctrl+K hint on a non-Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')

    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-kbd').text()).toBe('common.header.searchShortcutOther')
  })

  it('renders the platform-aware ⌘K hint on an Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')

    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-kbd').text()).toBe('common.header.searchShortcutMac')
  })
})

describe('HeaderSearch popularTags', () => {
  it('sorts tags by usage count descending, most-used first', async () => {
    const wrapper = await mountWithTags([
      { tag: 'a', usageCount: 1 },
      { tag: 'b', usageCount: 5 },
      { tag: 'c', usageCount: 3 }
    ])

    const renderedTags = wrapper.findAll('.w-chip').map((chip) => chip.text().trim())

    expect(renderedTags).toEqual(['b', 'c', 'a'])
  })
})

/**
 * OpenProject #830 (upstream PR #7688): a browser's password manager offers to fill a "username +
 * password" pair into whatever looks like a login form on the page, and without a signal telling it
 * otherwise a plain, unlabeled text field like this one can get scooped up as the "username" half --
 * autofilling a stray credential into the header search box. `autocomplete="off"` is the field's own
 * opt-out signal; this pins it as a regression test since nothing else about this field (no `name`,
 * no `type="search"`, sitting right next to the header's own controls) would otherwise stop a browser
 * from trying.
 */
describe('HeaderSearch autofill', () => {
  it('marks the input autocomplete="off" so password managers do not offer to fill it', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-input').attributes('autocomplete')).toBe('off')
  })
})
