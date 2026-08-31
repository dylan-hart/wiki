import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { initializeApi, isSessionExpiryUrl } from './api.js'
import { useUserStore } from '@/stores/user'

/*
  `initializeApi()`'s whole point is the `ky.create({ hooks })` wiring, so the real assertion is on
  what gets passed to `ky.create` -- not on a real network round trip. `ky` itself is mocked down to
  a spy that records its call, and each test invokes the captured `beforeError` hook directly with a
  synthetic `{ request, error }`, the same shape ky's own hook receives.
*/
const createMock = vi.fn()

vi.mock('ky', () => ({
  default: {
    create: (...args) => createMock(...args)
  }
}))

function stubRouter(path = '/some/page') {
  return {
    currentRoute: { value: { path, fullPath: path } },
    push: vi.fn()
  }
}

function beforeErrorHook() {
  const options = createMock.mock.calls.at(-1)[0]
  return options.hooks.beforeError[0]
}

function triggerBeforeError(status, url) {
  return beforeErrorHook()({
    request: { url },
    error: { response: { status } }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  createMock.mockClear()
})

describe('isSessionExpiryUrl()', () => {
  it('treats an ordinary route’s 401 as a session expiry', () => {
    expect(isSessionExpiryUrl('http://localhost/_api/sites/site-a/users/whoami')).toBe(true)
  })

  it('exempts the login route’s own 401 -- a bad password, not a session that lapsed', () => {
    expect(isSessionExpiryUrl('http://localhost/_api/sites/site-a/auth/login')).toBe(false)
  })

  it('exempts a page’s unlock route -- a wrong page password, not a session that lapsed', () => {
    expect(isSessionExpiryUrl('http://localhost/_api/sites/site-a/pages/abc123/unlock')).toBe(false)
  })
})

describe('initializeApi(): global session-expiry handling', () => {
  it('flips the user store to guest and pushes /login?redirect=… on an ordinary route’s 401', () => {
    const userStore = useUserStore()
    userStore.$patch({ authenticated: true, id: 'user-1' })
    const router = stubRouter('/some/page')
    initializeApi(router)

    triggerBeforeError(401, 'http://localhost/_api/sites/site-a/users/whoami')

    expect(userStore.authenticated).toBe(false)
    expect(router.push).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/some/page' }
    })
  })

  it('does neither for a 401 from the login call itself', () => {
    const userStore = useUserStore()
    userStore.$patch({ authenticated: true, id: 'user-1' })
    const router = stubRouter()
    initializeApi(router)

    triggerBeforeError(401, 'http://localhost/_api/sites/site-a/auth/login')

    expect(userStore.authenticated).toBe(true)
    expect(router.push).not.toHaveBeenCalled()
  })

  it('does neither for a 401 from the page-password unlock call', () => {
    const userStore = useUserStore()
    userStore.$patch({ authenticated: true, id: 'user-1' })
    const router = stubRouter()
    initializeApi(router)

    triggerBeforeError(401, 'http://localhost/_api/sites/site-a/pages/abc123/unlock')

    expect(userStore.authenticated).toBe(true)
    expect(router.push).not.toHaveBeenCalled()
  })

  it('leaves a non-401 error alone', () => {
    const userStore = useUserStore()
    userStore.$patch({ authenticated: true, id: 'user-1' })
    const router = stubRouter()
    initializeApi(router)

    triggerBeforeError(500, 'http://localhost/_api/sites/site-a/users/whoami')

    expect(userStore.authenticated).toBe(true)
    expect(router.push).not.toHaveBeenCalled()
  })

  it('does nothing when the tab is already showing as a guest -- a second 401 racing in', () => {
    const userStore = useUserStore()
    userStore.$patch({ authenticated: false })
    const router = stubRouter()
    initializeApi(router)

    triggerBeforeError(401, 'http://localhost/_api/sites/site-a/users/whoami')

    expect(router.push).not.toHaveBeenCalled()
  })

  it('returns the error unchanged, so the caller’s own catch still fires', () => {
    const router = stubRouter()
    initializeApi(router)
    const err = { response: { status: 401 } }

    const returned = beforeErrorHook()({
      request: { url: 'http://localhost/_api/sites/site-a/users/whoami' },
      error: err
    })

    expect(returned).toBe(err)
  })
})

/*
  Task 1758: the shared client used to override `throwHttpErrors` to `(statusNumber) => statusNumber
  > 400`, resolving a 400 instead of rejecting it -- every caller that wanted a 400 treated as an
  error (`AuthLoginPanel.vue`'s `login()`/`register()`/`changePwd()`/`resetPassword()` included) had
  to inspect `resp.ok` itself. `ky.create` is mocked in this file (see header comment above), so the
  real assertion reachable here is on the option actually handed to it -- `ky`'s own behavior for a
  `throwHttpErrors: true` client is `ky`'s to guarantee, not this suite's.
*/
describe('initializeApi(): throwHttpErrors', () => {
  it('passes throwHttpErrors: true to the shared ky client, rather than special-casing 400', () => {
    initializeApi(stubRouter())

    const options = createMock.mock.calls.at(-1)[0]

    expect(options.throwHttpErrors).toBe(true)
  })
})
