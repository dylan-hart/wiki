import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'
import { useUserStore } from '@/stores/user'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * `accent` is the standard tone for a non-destructive action such as entering tag edit mode; a
 * red-orange reads as a destructive one.
 */

beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountIndex() {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])
  const i18n = createTestI18n({})

  const userStore = useUserStore()
  // -> `canEditPage` reads `pagePermissions`, not the global `permissions` list.
  userStore.pagePermissions = ['write:pages']

  const pageStore = usePageStore()
  // -> The button's ancestor only renders when the page volunteered tags of its own.
  pageStore.showTags = true
  pageStore.tags = ['example']

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true,
        PageCommentsEmbed: true
      }
    }
  })
  activeWrapper = wrapper

  return { wrapper }
}

describe('Index.vue: page-tags edit toggle color (OpenProject #3108)', () => {
  it('renders the tags edit button in the standard accent color, not the deep-orange-9 red-tint', async () => {
    const { wrapper } = await mountIndex()

    const editBtn = wrapper.findComponent('.tags-edit-btn')
    expect(editBtn.exists()).toBe(true)
    expect(editBtn.props('color')).toBe('accent')
    expect(editBtn.props('color')).not.toBe('deep-orange-9')
  })
})
