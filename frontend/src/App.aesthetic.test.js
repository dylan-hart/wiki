// That `App.vue` actually WIRES the resolved `theme.aesthetic`/`user.aesthetic` values onto
// `<body>`; `composables/aesthetic.test.js` covers the resolution itself.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { createTestI18n } from '../test/i18n.js'

import { createTestRouter } from '../test/router.js'

let currentWrapper

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

  it('recomputes brand CSS custom properties when the aesthetic itself changes, with no manual applyTheme trigger', async () => {
    const { siteStore } = await mountApp()
    siteStore.theme.aesthetic = 'ledger'
    await triggerApplyTheme()
    expect(document.documentElement.style.getPropertyValue('--q-negative')).toBe('#c14a52')

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
    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  describe('recomputes brand CSS custom properties when appearance changes, with no manual applyTheme trigger', () => {
    it('resolves the Cobalt light header color on a personal light override', async () => {
      const { siteStore, userStore } = await mountApp()
      siteStore.theme.aesthetic = 'cobalt'
      userStore.appearance = 'light'
      await triggerApplyTheme()
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')

      // -> `#fff` is the `:root` fallback: a session where applyTheme() has never resolved Cobalt
      document.documentElement.style.setProperty('--q-header', '#ffffff')
      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#ffffff')

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

      userStore.appearance = 'site'
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.documentElement.style.getPropertyValue('--q-header')).toBe('#1f4fd6')
    })
  })

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
