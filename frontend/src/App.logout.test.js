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
import { flushPromises } from '@vue/test-utils'

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

/**
 * Moved here from `App.test.js` when that file was split by concern (TEST-F14): it covers the same
 * `'logout'` handler as the describe above, arrived at from the 2026-08-24 security audit rather
 * than from OpenProject #2208's own breakdown, and it observes each branch through
 * `router.currentRoute` rather than through a `push` spy. Kept whole rather than folded into the
 * describe above, since neither is a strict subset of the other in HOW it observes the outcome --
 * this one also proves the https:// branch does NOT additionally route internally, and the one above
 * covers a line-comment-disguised `javascript:` payload this one does not.
 *
 * OpenProject #1360/#2208: the `'logout'` `EVENT_BUS` handler used to treat ANY `scheme://` prefix as
 * "leaving the wiki" and call `window.location.assign()` on it directly -- `javascript://%0aalert(1)`
 * matches that same generic pattern, and a browser executes it as script once it decodes the `%0a`
 * into a real newline (the `//` becomes a JS line comment, ending before `alert(1)`). `redirect` is a
 * group's `redirectOnLogout`, so the actual attacker is whoever holds `manage:groups` (or
 * `write:pages`-adjacent delegation) on the group a victim is a member of -- every member of that
 * group gets this run on their next logout.
 */
describe('App.vue logout handler (OpenProject #2208)', () => {
  async function mountReadyWithOther() {
    const router = buildTestRouter(['/', '/other'])
    mountWithApp(App, { router })
    await router.push('/')
    await router.isReady()
    return router
  }

  async function emitLogout(redirect) {
    EVENT_BUS.emit('logout', { redirect })
    await flushPromises()
  }

  // -> `window.location.assign` is a genuine global: a spy left in place from one test would keep
  //    wrapping itself (and keep its recorded calls) into the next one.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses a javascript: redirect and routes to / internally instead of assigning it', async () => {
    const router = await mountReadyWithOther()
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('javascript://%0aalert(1)')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('refuses a scheme-relative //host redirect the same way', async () => {
    const router = await mountReadyWithOther()
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('//attacker.example')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('still leaves the wiki via window.location.assign for a genuine https:// redirect', async () => {
    const router = await mountReadyWithOther()
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('https://idp.example.com/logged-out')

    expect(assign).toHaveBeenCalledWith('https://idp.example.com/logged-out')
    // -> Not routed internally as well -- the two are mutually exclusive branches
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('still routes a same-origin path internally, unaffected by the scheme check', async () => {
    const router = await mountReadyWithOther()
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('/other')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/other')
  })

  it('routes to / when no redirect is given at all', async () => {
    const router = await mountReadyWithOther()
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout(undefined)

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })
})
