import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import HeaderSearch from './HeaderSearch.vue'
import { copyToClipboard } from '@/helpers/clipboard'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn()
}))

/**
 * Seeds `popularTags`/`popularTagsLoaded` -- the dedicated, recent-activity, capped-to-10 state the
 * panel reads -- not `tags`/`tagsLoaded`, which back a different, unrelated widget.
 */
async function mountWithTags(tags) {
  const router = await createTestRouter(['/'])

  const { wrapper } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.features.search = true
        store.popularTagsLoaded = true
        store.popularTags = tags
      }
    }
  })

  // -> The panel, and the popular-tags list inside it, renders only once the field is focused.
  await wrapper.find('.header-search-input').trigger('focus')

  return wrapper
}

/** `tabler:hash` reads as a `#` operator glyph rather than as a tag shape. */
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
 * Both modifiers have to work: Ctrl+K on macOS is the OS's own emacs kill-to-end-of-line binding,
 * already claimed there. The hint follows `navigator.platform`, stubbed per test.
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
   * `boot/i18n.js` creates the app's i18n instance with empty messages and loads the active locale's
   * catalog asynchronously afterwards, so a component setting up before that load finishes gets the
   * raw key back from `t()`. Mount with no messages, then load them the way boot does.
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
 * A hint that comes and goes with focus, or swaps for one of a different width once a query is
 * typed, shrinks `.header-search-field` and shifts the mode-toggle/tags buttons docked beside it.
 */
describe('HeaderSearch shortcut hint stays put across focus changes (OpenProject #3227)', () => {
  async function mountFocusable() {
    const router = await createTestRouter(['/'])
    const { wrapper } = mountWithApp(HeaderSearch, {
      router,
      stores: {
        site: (store) => {
          store.features.search = true
        }
      }
    })
    return wrapper
  }

  it('keeps the hint visible once the field is focused', async () => {
    const wrapper = await mountFocusable()
    expect(wrapper.find('.header-search-kbd').exists()).toBe(true)

    await wrapper.find('.header-search-input').trigger('focus')

    expect(wrapper.find('.header-search-kbd').exists()).toBe(true)
  })

  it('keeps the hint visible, and unchanged, once focused with a typed, unsubmitted query', async () => {
    const wrapper = await mountFocusable()
    await wrapper.find('.header-search-input').trigger('focus')
    const focusedText = wrapper.find('.header-search-kbd').text()

    await wrapper.find('.header-search-input').setValue('needle')

    const hint = wrapper.find('.header-search-kbd')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe(focusedText)
  })

  it('renders no more than one shortcut hint at a time', async () => {
    const wrapper = await mountFocusable()
    await wrapper.find('.header-search-input').trigger('focus')
    await wrapper.find('.header-search-input').setValue('needle')

    expect(wrapper.findAll('.header-search-kbd')).toHaveLength(1)
  })
})

/**
 * The docked tags button supplies the field's right edge (`.header-search-field--docked` drops the
 * field's own `border-inline-end`), so a ring on the field alone breaks visibly at the seam:
 * `is-focused` belongs on the row wrapping both controls.
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
 * The search input is a 13.5px role in both aesthetics; with `font: inherit` and nothing of its own
 * it would fall through to `body`'s unrelated 14px fallback base.
 *
 * Mounted attached to `document.body` because happy-dom's `getComputedStyle` needs a real body
 * ancestor to resolve a cascaded property at all, returning `''` for an unattached wrapper.
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

  /** The backend already caps this endpoint at 10; the widget does not trust that ceiling blindly. */
  it('renders at most 10 chips even if popularTags carries more', async () => {
    const tags = Array.from({ length: 15 }, (_, i) => ({
      tag: `tag-${i}`,
      usageCount: 15 - i
    }))
    const wrapper = await mountWithTags(tags)

    expect(wrapper.findAll('.w-chip')).toHaveLength(10)
  })

  /**
   * The dedicated popular-tags endpoint, not the all-time/unlimited `sites/:siteId/tags` the
   * tag-edit autocomplete and the tag-browse page use.
   */
  it('fetches sites/:siteId/tags/popular when the panel opens', async () => {
    const router = await createTestRouter(['/'])
    const { wrapper, siteStore } = mountWithApp(HeaderSearch, {
      router,
      stores: {
        site: (store) => {
          store.id = 'site-1'
          store.features.search = true
        }
      }
    })

    await wrapper.find('.header-search-input').trigger('focus')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tags/popular')
    expect(siteStore.popularTagsLoaded).toBe(true)

    wrapper.unmount()
  })
})

/**
 * A password manager fills a "username + password" pair into whatever looks like a login form, and
 * nothing else about this field -- no `name`, no `type="search"` -- would stop it scooping the box
 * up as the "username" half.
 */
describe('HeaderSearch autofill', () => {
  it('marks the input autocomplete="off" so password managers do not offer to fill it', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-input').attributes('autocomplete')).toBe('off')
  })
})

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
