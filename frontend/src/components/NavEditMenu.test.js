import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileStyleAsync } from 'vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import NavEditMenu from './NavEditMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useDark } from '@/composables/dark'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'navEdit.title': 'Edit Navigation',
  'navEdit.editMenuItems': 'Edit Menu Items',
  'navEdit.saveModeSuccess': 'Navigation mode set successfully.',
  'navEdit.menuSourceLabel': 'Menu Source',
  'navEdit.menuSourceStatic': 'Manual',
  'navEdit.menuSourceStaticHint': 'Menu items are entered by hand below.',
  'navEdit.menuSourceAuto': 'Automatic',
  'navEdit.menuSourceAutoHint': 'Menu items are generated automatically.',
  'navEdit.menuSourceMixed': 'Mixed',
  'navEdit.menuSourceMixedHint': 'Generated items are combined with manual ones.',
  'navEdit.modeSectionLabel': 'Sidebar for this page',
  'navEdit.modeShow': 'Show',
  'navEdit.modeShowHint': 'Show the sidebar menu across the site.',
  'navEdit.modeHide': 'Hide',
  'navEdit.modeHideHint': 'Completely hide the sidebar menu.',
  'navEdit.modeInherit': 'Inherit',
  'navEdit.modeInheritHint': 'Use the menu and settings from the parent path.',
  'navEdit.modeOverride': 'Override, this page and below',
  'navEdit.modeOverrideHint': 'Set menu items and settings for this path and all descendants.',
  'navEdit.modeOverrideExact': 'Override, this page only',
  'navEdit.modeOverrideExactHint': 'Set menu items and settings only for this path.',
  'navEdit.modeHideDescendants': 'Hide, this page and below',
  'navEdit.modeHideDescendantsHint': 'No sidebar for this path and all descendants.',
  'navEdit.modeHideExact': 'Hide, this page only',
  'navEdit.modeHideExactHint': 'No sidebar only for this path.',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save'
}

const SERVER_ITEMS = [{ id: 'fresh', type: 'link', label: 'Fresh' }]

function mountMenu({
  path = '',
  navigationId = 'nav-1',
  navigationMode = 'inherit',
  attachTo
} = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = path
  pageStore.navigationId = navigationId
  pageStore.navigationMode = navigationMode

  API_CLIENT.get.mockImplementation((url) => {
    if (url === `sites/site-1/navigation/${navigationId}/mode`) {
      return { json: vi.fn().mockResolvedValue({ mode: 'auto' }) }
    }
    if (url === 'sites/site-1/navigation/pages/page-1/inherited') {
      return { json: vi.fn().mockResolvedValue({ navigationId: 'ancestor-nav' }) }
    }
    // -> The sidebar's own re-fetch, once `save()` force-refreshes it -- any `.../navigation/<id>`
    //    not already matched above. Wrapped in the `{ mode, items }` envelope the real endpoint
    //    returns; `fetchNavigation()` (`stores/site.js`) destructures it, not a bare array.
    if (url.startsWith('sites/site-1/navigation/')) {
      return { json: vi.fn().mockResolvedValue({ mode: 'static', items: SERVER_ITEMS }) }
    }
    return { json: vi.fn().mockResolvedValue({}) }
  })

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(NavEditMenu, {
    global: { plugins: [i18n] },
    ...(attachTo ? { attachTo } : {})
  })

  return { wrapper, siteStore, pageStore }
}

describe('NavEditMenu', () => {
  afterEach(() => {
    document.documentElement.classList.remove('theme-transition-suppress')
  })

  /**
   * OpenProject #2819: `loadMenuMode()`'s resolve used to flip `state.menuMode` from its hardcoded
   * `'static'` default to the real value while the `w-btn-toggle` was still animating the popup's
   * open, producing a visible Manual -> Automatic (or -> Mixed) jump. Same fix, same proof, as
   * `dark.test.js`'s "adds the transition-suppress class synchronously with the flip" case: the
   * class is still on `<html>` right after the load resolves (it only clears on the next
   * `requestAnimationFrame`), and `state.menuMode` has already landed by then too.
   */
  it("suppresses transitions around loadMenuMode's own state.menuMode assignment", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(true)
    const autoSegment = wrapper
      .findAll('button[role="radio"]')
      .find((b) => b.text() === 'Automatic')
    expect(autoSegment.attributes('aria-checked')).toBe('true')

    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(false)
  })

  it("loads the resolved menu's source mode on mount and saves it alongside the cascade mode", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1/mode')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'inherit', menuMode: 'auto' }
    })
  })

  it('skips loading a source mode when there is no resolved menu (sidebar hidden)', async () => {
    mountMenu({ navigationId: null })
    await flushPromises()

    expect(API_CLIENT.get).not.toHaveBeenCalledWith(expect.stringContaining('/mode'))
  })

  /**
   * OpenProject #1012's fix landed on `NavEditOverlay.vue`'s own Save button, but this popup's own
   * Save (which persists `mode`/`menuMode` directly, without ever opening the item editor) never
   * got the same force-refetch -- so a `menuMode` change (or an `override` <-> `overrideExact`
   * toggle) that resolves to the SAME `navigationId` left the sidebar showing stale items until a
   * full reload, since `NavSidebar.vue`'s `pageStore.navigationId` watcher only fires on an actual
   * id change and `fetchNavigation()`'s own cache gate would skip an unchanged id regardless.
   */
  it('force-refetches the sidebar nav on save, even when the resolved id is unchanged', async () => {
    const { wrapper, siteStore } = mountMenu()
    await flushPromises()

    siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    // -> The default `API_CLIENT.get` mock resolves `SERVER_ITEMS` for any `.../navigation/<id>` --
    //    no longer `stale` is the proof the gate was bypassed, not just that some request went out.
    await vi.waitUntil(() => siteStore.nav.items[0]?.id === 'fresh')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
  })

  it('passes the loaded menuMode through to the item editor via overlayOpts on "Edit Menu Items"', async () => {
    const { wrapper, siteStore } = mountMenu()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('Edit Menu Items'))
    await editBtn.trigger('click')

    expect(siteStore.overlay).toBe('NavEdit')
    expect(siteStore.overlayOpts.menuMode).toBe('auto')
    expect(siteStore.overlayOpts.mode).toBe('inherit')
  })

  /**
   * Ledger restyle (Task #2799): the five non-root cascade rows render as radios sharing one
   * `v-model`, with a `NavCascadeGlyph` per row -- not the three-radio "Menu Source" list the
   * pre-restyle markup also used, which is a `w-btn-toggle` segmented control now (below).
   */
  it('renders one radio per non-root cascade mode, off the root', async () => {
    const { wrapper } = mountMenu({ path: 'docs/ingest' })
    await flushPromises()

    const radios = wrapper.findAll('[role="radio"]').filter((r) => r.attributes('aria-label'))
    // -> Five cascade radios plus the three Menu Source segments (also role="radio", part of
    //    `w-btn-toggle`'s own `radiogroup`) -- filtered down to the cascade group by their labels.
    const cascadeLabels = radios.map((r) => r.attributes('aria-label'))
    expect(cascadeLabels).toEqual([
      'Inherit',
      'Override, this page and below',
      'Override, this page only',
      'Hide, this page and below',
      'Hide, this page only'
    ])
  })

  it('renders only Show/Hide at the root, not the five descendant-cascade rows', async () => {
    const { wrapper } = mountMenu({ path: '' })
    await flushPromises()

    const radios = wrapper.findAll('[role="radio"]').filter((r) => r.attributes('aria-label'))
    const cascadeLabels = radios.map((r) => r.attributes('aria-label'))
    expect(cascadeLabels).toEqual(['Show', 'Hide'])
  })

  it('saves the mode picked by clicking a cascade row, not just the mounted default', async () => {
    const { wrapper } = mountMenu({ path: 'docs/ingest', navigationMode: 'inherit' })
    await flushPromises()

    const overrideRadio = wrapper
      .findAll('[role="radio"]')
      .find((r) => r.attributes('aria-label') === 'Override, this page and below')
    await overrideRadio.trigger('click')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'override', navigationId: 'nav-1' })
    })
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'override', menuMode: 'auto' }
    })
  })

  /**
   * Ledger restyle: "Menu Source" is a `w-btn-toggle` segmented control now, not three radios --
   * still driving the same `state.menuMode` the popup already saved (`menuMode` in the PUT body).
   */
  it('saves the menu source picked from the segmented control', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const autoSegment = wrapper
      .findAll('button[role="radio"]')
      .find((b) => b.text() === 'Automatic')
    expect(autoSegment).toBeTruthy()
    // -> Already `auto` from `loadMenuMode`'s own mocked response -- switch to Manual instead, so
    //    the assertion below proves the control's own click is what drives `state.menuMode`.
    const manualSegment = wrapper.findAll('button[role="radio"]').find((b) => b.text() === 'Manual')
    await manualSegment.trigger('click')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'inherit', menuMode: 'static' }
    })
  })

  /**
   * OpenProject #2820: `WBtnToggle.vue`'s shared segment styling only suppresses a middle/last
   * segment's START border -- the group's own two OUTER edges (the first segment's start border,
   * the last segment's end border) still draw, and here they double up against `.nav-edit-menu`'s
   * own card border. Scoped fix in `NavEditMenu.vue` alone, asserted via `getComputedStyle` the
   * same way `GraphClientTypeFilter.test.js` checks a layout property.
   */
  it("removes the menu source toggle's own outer borders (no double-border with the menu card)", async () => {
    const { wrapper } = mountMenu({ attachTo: document.body })
    await flushPromises()

    const segments = wrapper.findAll('.nav-edit-menu__menu-source button[role="radio"]')
    expect(segments.length).toBeGreaterThanOrEqual(2)

    const first = getComputedStyle(segments[0].element)
    const last = getComputedStyle(segments[segments.length - 1].element)

    expect(first.borderInlineStartWidth).toBe('0')
    expect(last.borderInlineEndWidth).toBe('0')
  })

  it('hides the menu source control and Edit Menu Items button when canEditMenuItems is false', async () => {
    const { wrapper } = mountMenu({ navigationId: null, navigationMode: 'hide' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('Menu Source')
    expect(wrapper.findAll('button').find((b) => b.text().includes('Edit Menu Items'))).toBeFalsy()
  })

  /**
   * OpenProject #2818: `.nav-edit-menu__menu-source-hint` only declared `padding-top`, leaving the
   * hint text flush against the menu card's border -- unlike its siblings in the same
   * `.nav-edit-menu__section` (`.nav-edit-menu__section-label` and `.nav-edit-menu__row`), which
   * both establish 14px horizontal padding as the section's convention. Read back through the real,
   * compiled `getComputedStyle` (this workspace's `test.css: true` + happy-dom environment actually
   * runs the SFC's `<style scoped>` block), following `NavSidebar.test.js`'s established pattern for
   * this exact kind of assertion -- a source-text grep can't tell "14px" apart from "any other
   * value", which is what this needs to pin down, unlike the border-presence checks that pattern
   * itself asserts.
   */
  it('gives the menu-source hint the same 14px horizontal padding as its section siblings (OpenProject #2818)', async () => {
    const { wrapper } = mountMenu({ attachTo: document.body })
    await flushPromises()

    const hint = wrapper.find('.nav-edit-menu__menu-source-hint')
    expect(hint.exists()).toBe(true)

    const style = getComputedStyle(hint.element)
    expect(style.paddingLeft).toBe('14px')
    expect(style.paddingRight).toBe('14px')

    wrapper.unmount()
  })

  /**
   * Cobalt restyle (Task #2800): the Save button's fill is `color="slate"`, resolved as an inline
   * style `WBtn` sets itself -- the only way `body.body--cobalt`'s own CSS can override it to the
   * handoff's distinct Cobalt slate-button tone is a class-scoped `!important` rule, so this class
   * is the one stable anchor that override needs. Not a color/style assertion (jsdom doesn't resolve
   * the aesthetic's `var()` cascade reliably) -- just proof the anchor survives future edits.
   */
  it("keeps the Save button's Cobalt-override class anchor", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    expect(saveBtn.classes()).toContain('nav-edit-menu__save-btn')
  })
})

/**
 * OpenProject #2807: `--color-accent-fill` has no dark-mode override anywhere in `tailwind.css`, so
 * the selected cascade-mode radio and the selected "Menu source" toggle segment both drew the same
 * bright light-mode tone against a dark ground. Fixed by resolving `color`/`toggle-color` through
 * `dark.isActive` instead of the static `accent-fill` prop.
 */
describe('NavEditMenu accent-fill dark mode (OpenProject #2807)', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark', 'body--light')
  })

  /*
    The color is on the ring/dot spans inside `w-radio`'s root button (`WRadio.vue`'s own inline
    `:style`), not on the button itself, which carries the `nav-edit-menu__radio` class.
  */
  it('draws the selected cascade-mode radio in accent-dark under dark mode', async () => {
    useDark().set(true)
    const { wrapper } = mountMenu()
    await flushPromises()

    const dot = wrapper.find('.nav-edit-menu__radio[aria-checked="true"] span[style]')
    expect(dot.attributes('style')).toContain('var(--color-accent-dark)')
    expect(dot.attributes('style')).not.toContain('var(--color-accent-fill)')
  })

  it('draws the selected cascade-mode radio in accent-fill under light mode', async () => {
    useDark().set(false)
    const { wrapper } = mountMenu()
    await flushPromises()

    const dot = wrapper.find('.nav-edit-menu__radio[aria-checked="true"] span[style]')
    expect(dot.attributes('style')).toContain('var(--color-accent-fill)')
    expect(dot.attributes('style')).not.toContain('var(--color-accent-dark)')
  })

  it('fills the selected "Menu source" segment with accent-dark under dark mode', async () => {
    useDark().set(true)
    const { wrapper } = mountMenu()
    await flushPromises()

    const selectedSegment = wrapper.find(
      '.nav-edit-menu__menu-source .w-btn-toggle__segment[aria-checked="true"]'
    )
    expect(selectedSegment.attributes('style')).toContain('var(--color-accent-dark)')
    expect(selectedSegment.attributes('style')).not.toContain('var(--color-accent-fill)')
  })
})

/**
 * OpenProject #2902: the unselected "Menu Source" segments drew `--color-ink` -- unchanged between
 * Cobalt light and dark (`tailwind.css`'s `body.body--cobalt.body--dark` block never redefines it)
 * -- against the dark panel behind them, because this file's own `body.body--cobalt ...` rule beat
 * `WBtnToggle.vue`'s correct `:global(body.body--dark .w-btn-toggle__segment[aria-checked='false'])`
 * dark-mode rule on specificity alone. Fixed by scoping this file's rule to `:not(.body--dark)`, so
 * it stops matching under dark mode and the segment falls through to `WBtnToggle.vue`'s own rule
 * instead (`--color-text-dark`, already correct and already Cobalt-dark-aware via tailwind.css).
 *
 * The selectors below are extracted from each component's own COMPILED `<style scoped>` output
 * (via `vue/compiler-sfc#compileStyleAsync`, `darkModeGlobalSelector.test.js`'s established tool for
 * this exact class of bug) rather than retyped by hand, so a future edit to either rule's selector
 * is what these tests actually exercise -- not a copy that could quietly drift from the source. Which
 * rule WINS the match under each body-class combination is then a plain CSS selector question,
 * answered directly by `Element.matches()` with no layout/paint engine involved -- unlike resolving
 * the final computed `color` would need (a `var()` cascade through stacked body classes isn't
 * reliably resolvable under `happy-dom`; see `cobaltDarkBandTokens.test.js`'s own comment on this).
 */
describe('NavEditMenu menu-source unselected-segment dark-mode contrast (OpenProject #2902)', () => {
  /*
    `new URL('./x', import.meta.url)` throws `TypeError: The URL must be of scheme file` under this
    workspace's `happy-dom` environment (see `test/realGridLayout.js`'s own comment on the identical
    issue) -- resolving via `node:path` off `fileURLToPath` sidesteps it.
  */
  const selfDir = dirname(fileURLToPath(import.meta.url))

  /**
   * Compiles `file`'s `<style scoped>` block for real, splits it into individual rules on `}`, and
   * returns the selector text of the one rule whose selector contains `selectorMarker` -- i.e. the
   * exact, real selector that rule actually compiles under, not a hand-copied guess. Throws loudly
   * if the block is missing or `selectorMarker` doesn't identify exactly one rule, so a rename (or a
   * marker too loose to disambiguate) shows up as a failing test rather than a silently-wrong match.
   */
  async function compiledSelectorFor(file, selectorMarker) {
    const source = readFileSync(join(selfDir, file), 'utf-8')
    const styleMatch = source.match(/<style scoped>([\s\S]*?)<\/style>/)
    if (!styleMatch) throw new Error(`${file}: no <style scoped> block found`)
    const result = await compileStyleAsync({
      source: styleMatch[1],
      filename: file,
      id: `data-v-${file.replace(/\W/g, '')}-test`,
      scoped: true
    })
    const selectors = result.code
      .split('}')
      .map((rule) => rule.split('{')[0].replace(/\s+/g, ' ').trim())
      .filter((selector) => selector.includes(selectorMarker))
    if (selectors.length !== 1) {
      throw new Error(
        `${file}: expected exactly one rule matching "${selectorMarker}", found ${selectors.length}`
      )
    }
    return selectors[0]
  }

  afterEach(() => {
    document.body.className = ''
    document.body.innerHTML = ''
  })

  it("compiles NavEditMenu.vue's unselected-segment rule to a `:not(.body--dark)`-scoped selector, not dropping the descendant", async () => {
    const selector = await compiledSelectorFor(
      'NavEditMenu.vue',
      "w-btn-toggle__segment[aria-checked='false']"
    )
    expect(selector).toBe(
      "body.body--cobalt:not(.body--dark) .nav-edit-menu__menu-source .w-btn-toggle__segment[aria-checked='false']"
    )
  })

  it("WBtnToggle.vue's dark-mode fallback rule still compiles with its descendant intact", async () => {
    const selector = await compiledSelectorFor(
      'shared/WBtnToggle.vue',
      "body.body--dark .w-btn-toggle__segment[aria-checked='false']"
    )
    expect(selector).toBe("body.body--dark .w-btn-toggle__segment[aria-checked='false']")
  })

  function mountUnselectedSegment() {
    const container = document.createElement('div')
    container.className = 'nav-edit-menu'
    container.innerHTML =
      '<div class="nav-edit-menu__menu-source">' +
      '<button class="w-btn-toggle__segment" aria-checked="false"></button>' +
      '</div>'
    document.body.appendChild(container)
    return container.querySelector('.w-btn-toggle__segment')
  }

  it('matches the Cobalt-only rule under light Cobalt, leaving the fallback rule unmatched', async () => {
    const cobaltSelector = await compiledSelectorFor(
      'NavEditMenu.vue',
      "w-btn-toggle__segment[aria-checked='false']"
    )
    const fallbackSelector = await compiledSelectorFor(
      'shared/WBtnToggle.vue',
      "body.body--dark .w-btn-toggle__segment[aria-checked='false']"
    )

    document.body.className = 'body--cobalt'
    const segment = mountUnselectedSegment()

    expect(segment.matches(cobaltSelector)).toBe(true)
    expect(segment.matches(fallbackSelector)).toBe(false)
  })

  it('stops matching the Cobalt-only rule under Cobalt dark mode, so the dark fallback rule applies instead', async () => {
    const cobaltSelector = await compiledSelectorFor(
      'NavEditMenu.vue',
      "w-btn-toggle__segment[aria-checked='false']"
    )
    const fallbackSelector = await compiledSelectorFor(
      'shared/WBtnToggle.vue',
      "body.body--dark .w-btn-toggle__segment[aria-checked='false']"
    )

    document.body.className = 'body--cobalt body--dark'
    const segment = mountUnselectedSegment()

    expect(segment.matches(cobaltSelector)).toBe(false)
    expect(segment.matches(fallbackSelector)).toBe(true)
  })
})
