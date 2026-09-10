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
 * search field's right edge, matching the 2.5.x reference layout -- `tabler:tags` rather than the
 * previous `tabler:hash`, which read as a `#` operator glyph rather than a tag shape.
 */
describe('HeaderSearch "Browse by tags" entry point (OpenProject #1218)', () => {
  it('renders a link to /_tags docked against the field, unconditionally', async () => {
    const wrapper = await mountWithTags([])

    const tagsLink = wrapper.find('.header-search-tags-btn')
    expect(tagsLink.exists()).toBe(true)
    expect(tagsLink.attributes('href')).toBe('/_tags')
  })

  it('uses the tabler:tags icon, not tabler:hash', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-tags-btn [data-icon]').attributes('data-icon')).toBe(
      'tabler:tags'
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

  const SHORTCUT_HINT_MESSAGES = {
    'common.header.searchShortcutMac': '⌘K',
    'common.header.searchShortcutOther': 'Ctrl+K'
  }

  async function mountAttached(messages) {
    const router = await createTestRouter(['/'])

    const { wrapper, i18n } = mountWithApp(HeaderSearch, {
      attachTo: document.body,
      router,
      messages,
      stores: {
        site: (store) => {
          store.features.search = true
        }
      }
    })
    activeWrapper = wrapper
    return { wrapper, i18n }
  }

  it('focuses the field on Ctrl+K', async () => {
    const { wrapper } = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('also focuses the field on Cmd+K (metaKey) -- previously unbound entirely', async () => {
    const { wrapper } = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('marks the field aria-keyshortcuts for both modifiers', async () => {
    const { wrapper } = await mountAttached()

    expect(wrapper.find('.header-search-input').attributes('aria-keyshortcuts')).toBe(
      'Meta+K Control+K'
    )
  })

  it('renders the resolved Ctrl+K hint on a non-Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')

    const { wrapper } = await mountAttached(SHORTCUT_HINT_MESSAGES)

    expect(wrapper.find('.header-search-kbd').text()).toBe('Ctrl+K')
  })

  it('renders the resolved, platform-aware ⌘K hint on an Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')

    const { wrapper } = await mountAttached(SHORTCUT_HINT_MESSAGES)

    expect(wrapper.find('.header-search-kbd').text()).toBe('⌘K')
  })

  /**
   * OpenProject #2511: the hint used to be captured once into a plain `const` at setup, not a
   * `computed()`. `boot/i18n.js` creates the real app's i18n instance with empty messages and loads
   * the active locale's catalog asynchronously afterward, so a component that sets up before that
   * load finishes got the raw key back from `t()` and, being a frozen `const`, stayed stuck on it
   * for its entire mounted lifetime even once the real messages landed. This reproduces exactly that
   * race -- mount with no messages loaded yet (as `createTestI18n({})` defaults to), then load them
   * the way the real boot sequence does, and assert the hint updates in place rather than needing a
   * remount.
   */
  it('updates the hint once the locale catalog loads after mount, rather than staying on the raw key', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')

    const { wrapper, i18n } = await mountAttached()

    expect(wrapper.find('.header-search-kbd').text()).toBe('common.header.searchShortcutOther')

    i18n.global.setLocaleMessage('en', SHORTCUT_HINT_MESSAGES)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.header-search-kbd').text()).toBe('Ctrl+K')
  })
})

/**
 * OpenProject #2718: `is-focused` used to live on `.header-search-field` alone, so the focus ring
 * could only darken the field's own edges -- the docked tags button, which supplies the shared
 * right edge (`.header-search-field--docked` drops the field's own `border-inline-end`), kept its
 * static hairline and the ring visibly broke at the seam. The class now lives on the row wrapping
 * both controls, so it should land on `.header-search-row-inline` and never directly on the field,
 * with both the field and the tags button reachable as descendants of that same focused row.
 */
describe('HeaderSearch focus ring spans the field and the docked tags button (OpenProject #2718)', () => {
  it('puts is-focused on the row, not on the field, once the input is focused', async () => {
    const router = await createTestRouter(['/'])
    const { wrapper } = mountWithApp(HeaderSearch, {
      router,
      stores: {
        site: (store) => {
          store.features.search = true
        }
      }
    })

    const row = wrapper.find('.header-search-row-inline')
    const field = wrapper.find('.header-search-field')
    expect(row.classes()).not.toContain('is-focused')
    expect(field.classes()).not.toContain('is-focused')

    await wrapper.find('.header-search-input').trigger('focus')

    expect(row.classes()).toContain('is-focused')
    expect(field.classes()).not.toContain('is-focused')
  })

  it('keeps both the field and the docked tags button as descendants of the focused row', async () => {
    const wrapper = await mountWithTags([])
    await wrapper.find('.header-search-input').trigger('focus')

    const focusedRow = wrapper.find('.header-search-row-inline.is-focused')
    expect(focusedRow.exists()).toBe(true)
    expect(focusedRow.find('.header-search-field').exists()).toBe(true)
    expect(focusedRow.find('.header-search-tags-btn').exists()).toBe(true)
  })
})

/**
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §3's header-bar role table: the search
 * placeholder/input is a 13.5px role, identical in Ledger and Cobalt (only `color` differs between
 * the two aesthetics) -- `font: inherit` on `.header-search-input` used to leave it with no
 * font-size of its own, falling through the ancestor chain to `body`'s unrelated 14px fallback base
 * (`tailwind.css`'s documented "fallback, not a role").
 *
 * Mounted attached to `document.body`, following `EditorWysiwyg.darkMode.test.js`'s established
 * pattern -- happy-dom's `getComputedStyle` needs a real body ancestor to resolve a cascaded
 * property at all, returning `''` for an unattached wrapper rather than the initial/inherited value.
 */
describe('HeaderSearch placeholder/input type role (cobalt-typography.md §3)', () => {
  it('sets the search input to the 13.5px role size, not the 14px body fallback', async () => {
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

    const input = wrapper.find('.header-search-input').element
    expect(getComputedStyle(input).fontSize).toBe('13.5px')

    wrapper.unmount()
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

/**
 * OpenProject #2995: the "Search Operators" hints used to always render whenever the panel was
 * open. It is now collapsed by default, behind a header the reader clicks to expand -- with no
 * persisted state, so it starts collapsed again on every fresh open. Popular Tags, directly above
 * it in the panel, is unaffected and stays unconditionally visible.
 */
describe('HeaderSearch "Search Operators" hints (OpenProject #2995)', () => {
  it('starts collapsed: no tip rows render, and the toggle reports aria-expanded="false"', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.findAll('.searchpanel-tip')).toHaveLength(0)
    expect(wrapper.find('.searchpanel-operators-toggle').attributes('aria-expanded')).toBe('false')
  })

  it('expands to show all four tip rows on click, and reports aria-expanded="true"', async () => {
    const wrapper = await mountWithTags([])

    await wrapper.find('.searchpanel-operators-toggle').trigger('click')

    expect(wrapper.findAll('.searchpanel-tip')).toHaveLength(4)
    expect(wrapper.find('.searchpanel-operators-toggle').attributes('aria-expanded')).toBe('true')
  })

  it('collapses again on a second click', async () => {
    const wrapper = await mountWithTags([])

    await wrapper.find('.searchpanel-operators-toggle').trigger('click')
    await wrapper.find('.searchpanel-operators-toggle').trigger('click')

    expect(wrapper.findAll('.searchpanel-tip')).toHaveLength(0)
    expect(wrapper.find('.searchpanel-operators-toggle').attributes('aria-expanded')).toBe('false')
  })

  it('does not persist an expanded state across a close-then-reopen of the panel', async () => {
    const wrapper = await mountWithTags([])

    await wrapper.find('.searchpanel-operators-toggle').trigger('click')
    expect(wrapper.findAll('.searchpanel-tip')).toHaveLength(4)

    // -> Blurring the field (with nothing else in the panel receiving focus) closes the panel.
    await wrapper.find('.header-search-input').trigger('blur')
    expect(wrapper.find('.searchpanel').exists()).toBe(false)

    await wrapper.find('.header-search-input').trigger('focus')

    expect(wrapper.find('.searchpanel').exists()).toBe(true)
    expect(wrapper.findAll('.searchpanel-tip')).toHaveLength(0)
    expect(wrapper.find('.searchpanel-operators-toggle').attributes('aria-expanded')).toBe('false')
  })

  it('leaves Popular Tags always visible, unaffected by the collapsed operators state', async () => {
    const wrapper = await mountWithTags([{ tag: 'foo', usageCount: 1 }])

    expect(wrapper.find('.w-chip').exists()).toBe(true)
  })
})
