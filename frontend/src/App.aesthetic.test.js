// Feature #2753 / Task #2766: `App.vue`'s aesthetic resolution watch and `applyTheme()` wiring.
//
// Mirrors `App.theme.test.js`'s harness (mount the real `App.vue` against a fresh pinia + a memory
// router already settled on `/`, drive `applyTheme()` through the same `EVENT_BUS` event a real admin
// save fires) since this is the same kind of assertion: that `App.vue` actually WIRES the resolved
// `theme.aesthetic`/`user.aesthetic` values onto `<body>`, not merely that `composables/aesthetic.js`
// works in isolation (already covered by `composables/aesthetic.test.js`).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { createTestI18n } from '../test/i18n.js'

import { createTestRouter } from '../test/router.js'

let currentWrapper

/** Same shape as `App.theme.test.js`'s `mountApp()` -- see that file for the reasoning. */
async function mountApp() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const router = await createTestRouter(['/'])
  const i18n = createTestI18n()

  currentWrapper = mount(App, {
    global: { plugins: [router, i18n] }
  })

  return { siteStore, userStore }
}

/** Same as `App.theme.test.js`'s `triggerApplyTheme()`. */
async function triggerApplyTheme() {
  EVENT_BUS.emit('applyTheme')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  // -> Mirrors index.html's structure: router.afterEach() unconditionally removes this element
  document.body.insertAdjacentHTML('afterbegin', '<div class="init-loading"></div>')
})

afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = undefined

  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.body.innerHTML = ''
  document.body.classList.remove('body--ledger', 'body--cobalt', 'body--dark', 'body--light')
  document.documentElement.classList.remove('theme-transition-suppress')
})

describe('App.vue aesthetic resolution', () => {
  it("a site admin's site.theme.aesthetic reaches <body> when the user follows the site", async () => {
    const { siteStore, userStore } = await mountApp()
    userStore.aesthetic = 'site'
    siteStore.theme.aesthetic = 'cobalt'
    await triggerApplyTheme()

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  it("a per-user aesthetic override takes precedence over the site's value", async () => {
    const { siteStore, userStore } = await mountApp()
    siteStore.theme.aesthetic = 'ledger'
    userStore.aesthetic = 'cobalt'
    await triggerApplyTheme()

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  it('a guest (aesthetic: site, the default) gets the site value', async () => {
    const { siteStore, userStore } = await mountApp()
    expect(userStore.authenticated).toBe(false)
    expect(userStore.aesthetic).toBe('site')

    siteStore.theme.aesthetic = 'cobalt'
    await triggerApplyTheme()

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
  })

  it('the userStore.aesthetic watch resolves and applies its own body class, with no manual applyTheme trigger', async () => {
    const { siteStore, userStore } = await mountApp()
    siteStore.theme.aesthetic = 'ledger'
    await triggerApplyTheme()
    expect(document.body.classList.contains('body--ledger')).toBe(true)

    userStore.aesthetic = 'cobalt'
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  /*
   * OpenProject #2887: the aesthetic watch used to flip `body--cobalt`/`body--ledger` directly
   * (via `aesthetic.set()`) without ever calling `applyTheme()`, so the brand CSS custom
   * properties `applyTheme()` derives via `resolveAestheticColors()` -- `--q-header`,
   * `--q-sidebar`, `--q-primary`, and the status colors below -- stayed stale until something
   * else (initial boot, the first router `afterEach`, a `cvd` change, or a manual `applyTheme`
   * EVENT_BUS emit) happened to recompute them. A reader switching aesthetics saw the body class
   * change but the navbar/sidebar fill stay the OLD aesthetic's color until a reload.
   */
  it('recomputes brand CSS custom properties when the aesthetic itself changes, with no manual applyTheme trigger', async () => {
    const { siteStore } = await mountApp()
    siteStore.theme.aesthetic = 'ledger'
    await triggerApplyTheme()
    expect(document.documentElement.style.getPropertyValue('--q-negative')).toBe('#c14a52')

    // -> No triggerApplyTheme() here: this is the live aesthetic switch, not an admin save.
    siteStore.theme.aesthetic = 'cobalt'
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.documentElement.style.getPropertyValue('--q-negative')).toBe('#c8303c')
  })

  it('switching aesthetic does not affect the independent appearance (dark/light) axis', async () => {
    const { siteStore, userStore } = await mountApp()
    userStore.appearance = 'dark'
    siteStore.theme.aesthetic = 'ledger'
    await triggerApplyTheme()
    expect(document.body.classList.contains('body--dark')).toBe(true)

    userStore.aesthetic = 'cobalt'
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    // -> The aesthetic axis flipped; the appearance axis must not have moved
    expect(document.body.classList.contains('body--dark')).toBe(true)
    expect(document.body.classList.contains('body--light')).toBe(false)
  })

  it('switching appearance does not affect the independent aesthetic axis', async () => {
    const { siteStore, userStore } = await mountApp()
    userStore.aesthetic = 'cobalt'
    siteStore.theme.dark = false
    await triggerApplyTheme()
    expect(document.body.classList.contains('body--cobalt')).toBe(true)

    userStore.appearance = 'dark'
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.classList.contains('body--dark')).toBe(true)
    // -> The appearance axis flipped; the aesthetic axis must not have moved
    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  /*
   * OpenProject #2956: the appearance (light/dark) watch used to call `dark.set()` directly
   * without ever calling `applyTheme()` -- the same class of bug #2887 fixed for the aesthetic
   * watch just above, but never applied to this one. `--q-header` (and the rest of the brand CSS
   * custom properties `resolveAestheticColors()` derives) stayed stale at whatever `applyTheme()`
   * last resolved, which is `#fff` (the `:root` fallback) if nothing had recomputed it yet this
   * session -- rendering the header bar white instead of Cobalt's blue in light mode.
   */
  describe('recomputes brand CSS custom properties when appearance changes, with no manual applyTheme trigger', () => {
    it('resolves the Cobalt light header color on a personal light override', async () => {
      const { siteStore, userStore } = await mountApp()
      siteStore.theme.aesthetic = 'cobalt'
      userStore.appearance = 'light'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')

      // -> Simulate a fresh session where applyTheme() has never resolved Cobalt's real color yet
      document.documentElement.style.setProperty('--q-header', '#ffffff')
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#ffffff')

      // -> No triggerApplyTheme() here: this is the live appearance toggle, not an admin save.
      userStore.appearance = 'dark'
      await new Promise((resolve) => setTimeout(resolve, 0))
      userStore.appearance = 'light'
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')
    })

    it('resolves the Cobalt dark header color on a personal dark override', async () => {
      const { siteStore, userStore } = await mountApp()
      siteStore.theme.aesthetic = 'cobalt'
      userStore.appearance = 'light'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')

      // -> No triggerApplyTheme() here: this is the live appearance toggle, not an admin save.
      userStore.appearance = 'dark'
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1a43bd')
    })

    it("re-resolves following the site's dark preference when appearance is 'site'", async () => {
      const { siteStore, userStore } = await mountApp()
      siteStore.theme.aesthetic = 'cobalt'
      siteStore.theme.dark = false
      userStore.appearance = 'dark'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1a43bd')

      // -> No triggerApplyTheme() here: this is the live appearance toggle, not an admin save.
      userStore.appearance = 'site'
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')
    })
  })

  /*
   * OpenProject #2814: `--q-positive`/`-negative`/`-info`/`-warning` used to be Ledger-literal
   * (two hardcoded, two never even set) regardless of aesthetic, so toast/banner fills stayed
   * Ledger-colored under Cobalt. They now follow the resolved aesthetic the same way `--q-primary`/
   * `-accent`/`-header`/`-sidebar` already did.
   */
  describe('status color CSS vars follow the resolved aesthetic', () => {
    afterEach(() => {
      document.documentElement.style.removeProperty('--q-positive')
      document.documentElement.style.removeProperty('--q-negative')
      document.documentElement.style.removeProperty('--q-info')
      document.documentElement.style.removeProperty('--q-warning')
    })

    it('sets the Ledger values under the ledger aesthetic', async () => {
      const { siteStore } = await mountApp()
      siteStore.theme.aesthetic = 'ledger'
      await triggerApplyTheme()

      const style = document.documentElement.style
      expect(style.getPropertyValue('--q-positive')).toBe('#3f7a66')
      expect(style.getPropertyValue('--q-negative')).toBe('#c14a52')
      expect(style.getPropertyValue('--q-info')).toBe('#38465f')
      expect(style.getPropertyValue('--q-warning')).toBe('#d9a441')
    })

    it('sets the Cobalt values under the cobalt aesthetic', async () => {
      const { siteStore } = await mountApp()
      siteStore.theme.aesthetic = 'cobalt'
      await triggerApplyTheme()

      const style = document.documentElement.style
      expect(style.getPropertyValue('--q-positive')).toBe('#177a5e')
      expect(style.getPropertyValue('--q-negative')).toBe('#c8303c')
      expect(style.getPropertyValue('--q-info')).toBe('#1e2a5e')
      // -> Warning deliberately stays the same value in both aesthetics
      expect(style.getPropertyValue('--q-warning')).toBe('#d9a441')
    })

    it('re-resolves the status colors when switching aesthetic at runtime', async () => {
      const { siteStore } = await mountApp()
      siteStore.theme.aesthetic = 'ledger'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-negative')).toBe('#c14a52')

      siteStore.theme.aesthetic = 'cobalt'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-negative')).toBe('#c8303c')
    })
  })
})
