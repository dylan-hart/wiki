import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import { useUserStore } from '@/stores/user'
import { useDirection } from '@/composables/direction'
import WMenu from '@/components/shared/WMenu.vue'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 727: two mirroring gaps in
 * the admin chrome that task 721's audit did not reach (it was scoped to NavSidebar/PageToc/
 * PageHeader/the editor toolbars, not the admin layout).
 *
 * The header's own language-switcher menu -- the exact control a reader uses to switch INTO an RTL
 * locale in the first place -- had a hardcoded `anchor="bottom right" self="top right"`, the same
 * bug `PageHeader.vue`'s review-queue dropdown had before task 721 fixed it via
 * `helpers/directionalAnchor.js`. Fixed the same way here, reactively off
 * `composables/direction.js` since this header, like `PageHeader.vue`'s, stays mounted across
 * navigations.
 */
async function mountAdminLayout() {
  setActivePinia(createPinia())
  useUserStore().$patch({ permissions: ['manage:system'] })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/_admin/:siteid?/:rest*', component: { template: '<div />' } },
      { path: '/_error/unauthorized', component: { template: '<div />' } }
    ]
  })
  router.push('/_admin/site-1/dashboard')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  // -> `fetchSites()` (called from `onMounted`) does `this.sites[0].id` when nothing came back --
  //    the default `API_CLIENT` stub resolves every call to `undefined`, which would throw. A
  //    stubbed site list is what a real backend would return here.
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'sites') {
      return { json: () => Promise.resolve([{ id: 'site-1', title: 'Test Site' }]) }
    }
    return { json: () => Promise.resolve([]) }
  })

  const wrapper = mount(AdminLayout, {
    global: {
      plugins: [router, i18n],
      stubs: {
        'router-view': true,
        AccountMenu: true,
        FooterNav: true
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('AdminLayout locale-switcher menu direction', () => {
  afterEach(() => {
    // -> `useDirection`'s backing ref is module-level state shared with every other test file that
    //    imports it in this run; leaving it flipped would bleed into whichever test happens to run next
    useDirection().set(false)
  })

  it('anchors the locale-switcher menu to the trailing (right) edge under ltr', async () => {
    const wrapper = await mountAdminLayout()

    const menu = wrapper.findComponent(WMenu)
    expect(menu.props('anchor')).toBe('bottom right')
    expect(menu.props('self')).toBe('top right')
  })

  it('mirrors the locale-switcher menu to the trailing (left) edge under rtl', async () => {
    useDirection().set(true)
    const wrapper = await mountAdminLayout()

    const menu = wrapper.findComponent(WMenu)
    expect(menu.props('anchor')).toBe('bottom left')
    expect(menu.props('self')).toBe('top left')
  })

  it('re-mirrors reactively when direction flips after mount', async () => {
    const wrapper = await mountAdminLayout()
    expect(wrapper.findComponent(WMenu).props('anchor')).toBe('bottom right')

    useDirection().set(true)
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WMenu).props('anchor')).toBe('bottom left')
  })
})

describe('AdminLayout nav count badge', () => {
  it('keeps the count badge on a logical (inline-end) border, not a physical one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/border-right\s*:/)
    expect(styleBlock).not.toMatch(/border-right-color\s*:/)
    expect(styleBlock).toMatch(/\.count-badge\s*\{\s*border-inline-end\s*:\s*5px/)
    expect(styleBlock).toMatch(/border-inline-end-color\s*:\s*\$positive/)
  })
})
