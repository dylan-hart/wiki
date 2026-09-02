// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// Same happy-dom environment options as `App.test.js`, for the same reasons (see that file's own
// header). Split into its own file the same way `App.beforeunload.test.js` is, so only this file's
// own `EVENT_BUS` listener registrations and router are ever in play.
//
// OpenProject #2208 §3/§9: `App.vue`'s `'logout'` handler used to test the redirect target with
// `/^[a-z][a-z0-9+.-]*:\/\//i` before handing it to `window.location.assign()` — satisfied by
// `javascript://%0aalert(1)` (the `//` reads as a JS line comment, the decoded newline ends it before
// the real scheme prefix would matter), and letting a protocol-relative `//evil.example` straight
// through to the router as if it were a same-origin path. `isFollowableRedirectTarget()` replaces
// the regex with the same rule the backend's `helpers/redirectTarget.ts` applies.
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../test/i18n.js'

import { buildTestRouter } from '../test/router.js'

import { mountWithApp } from '../test/mount.js'

async function mountReady() {
  const router = buildTestRouter(['/', '/some/page'])

  mountWithApp(App, {
    messages: { auth: { logoutSuccess: 'Logged out' } },
    router,
    stores: { site: { id: 'site-1' }, flags: { loaded: true }, user: { profileLoaded: true } }
  })
  await router.push('/')
  await router.isReady()

  return router
}

describe("App.vue 'logout' EVENT_BUS handler", () => {
  let assignSpy

  afterEach(() => {
    assignSpy?.mockRestore()
  })

  it('routes a same-origin rooted redirect through the router, not a page load', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', { redirect: '/some/page' })

    expect(pushSpy).toHaveBeenCalledWith('/some/page')
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('assigns location for a complete https:// redirect, leaving the wiki', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', { redirect: 'https://elsewhere.example/landing' })

    expect(assignSpy).toHaveBeenCalledWith('https://elsewhere.example/landing')
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('refuses a javascript: redirect, falling back to the router at /', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', { redirect: 'javascript:alert(1)' })

    expect(assignSpy).not.toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalledWith('/')
  })

  it('refuses a javascript: redirect disguised behind a line-comment (the naive-regex bypass)', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', { redirect: 'javascript://%0aalert(1)' })

    expect(assignSpy).not.toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalledWith('/')
  })

  it('refuses a protocol-relative //host redirect, falling back to the router at /', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', { redirect: '//evil.example' })

    expect(assignSpy).not.toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalledWith('/')
  })

  it('defaults to / when no redirect is given at all', async () => {
    const router = await mountReady()
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const pushSpy = vi.spyOn(router, 'push')

    EVENT_BUS.emit('logout', {})

    expect(assignSpy).not.toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalledWith('/')
  })
})
