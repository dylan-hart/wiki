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

  it('the userStore.aesthetic watch resolves and applies independently of applyTheme()', async () => {
    const { siteStore, userStore } = await mountApp()
    siteStore.theme.aesthetic = 'ledger'
    await triggerApplyTheme()
    expect(document.body.classList.contains('body--ledger')).toBe(true)

    userStore.aesthetic = 'cobalt'
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
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
})
