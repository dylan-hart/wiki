import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MainLayout from './MainLayout.vue'
import routes from '@/router/routes.js'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `AuthLoginPanel.vue` sets this flag immediately before a hard `window.location.replace()`, so a
 * fresh mount is what consumes it -- which is why the fixture is sessionStorage rather than a prop.
 */

const ENTRANCE_FLOURISH_KEY = 'cardinal:justLoggedIn'
const ENTRANCE_CLASS = 'main-layout--entrance-flourish'

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: true,
  MainOverlayDialog: true
}

function stubReducedMotion(matches) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
}

async function mountLayout() {
  const router = await createTestRouter(routes, '/some/wiki/page')
  return mountWithApp(MainLayout, { router, stubs: LAYOUT_STUBS })
}

describe('MainLayout entrance flourish', () => {
  let matchMediaSpy

  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    matchMediaSpy?.mockRestore()
    sessionStorage.clear()
  })

  describe('without prefers-reduced-motion', () => {
    beforeEach(() => {
      matchMediaSpy = stubReducedMotion(false)
    })

    it('plays the entrance flourish and clears the flag when it was present', async () => {
      sessionStorage.setItem(ENTRANCE_FLOURISH_KEY, '1')

      const { wrapper } = await mountLayout()

      expect(wrapper.classes()).toContain(ENTRANCE_CLASS)
      expect(sessionStorage.getItem(ENTRANCE_FLOURISH_KEY)).toBeNull()
    })

    it('renders immediately with no animation class when the flag is absent (a plain refresh)', async () => {
      const { wrapper } = await mountLayout()

      expect(wrapper.classes()).not.toContain(ENTRANCE_CLASS)
      expect(sessionStorage.getItem(ENTRANCE_FLOURISH_KEY)).toBeNull()
    })

    it('does not replay on a second mount within the same session (flag already consumed)', async () => {
      sessionStorage.setItem(ENTRANCE_FLOURISH_KEY, '1')

      await mountLayout()
      const { wrapper: second } = await mountLayout()

      expect(second.classes()).not.toContain(ENTRANCE_CLASS)
    })
  })

  describe('with prefers-reduced-motion', () => {
    beforeEach(() => {
      matchMediaSpy = stubReducedMotion(true)
    })

    it('skips the animation class but still clears the flag', async () => {
      sessionStorage.setItem(ENTRANCE_FLOURISH_KEY, '1')

      const { wrapper } = await mountLayout()

      expect(wrapper.classes()).not.toContain(ENTRANCE_CLASS)
      expect(sessionStorage.getItem(ENTRANCE_FLOURISH_KEY)).toBeNull()
    })

    it('renders immediately with no class when the flag is also absent', async () => {
      const { wrapper } = await mountLayout()

      expect(wrapper.classes()).not.toContain(ENTRANCE_CLASS)
    })
  })
})
