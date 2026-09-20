import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminLayout from './AdminLayout.vue'
import { useUserStore } from '@/stores/user'
import { useDirection } from '@/composables/direction'
import WMenu from '@/components/shared/WMenu.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/*
  `stores/common.js` reads `localStorage.getItem('locale')` when the store is created, and every
  mount here pulls that store in. Node's own experimental global `localStorage` shadows happy-dom's
  with one that has no `.getItem`, so stub past the collision -- no test cares about a stored locale.
*/
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  })
})

describe('AdminLayout sidebar nav', () => {
  async function mountLayout({
    experimental,
    permissions = ['access:admin', 'manage:sites'],
    sitePermissions = []
  }) {
    // -> The default stub resolves every call to `undefined`: `sites` has to answer with one site
    //    for `fetchSites()` to set a `currentSiteId`, and the `userPermissions` call that
    //    AdminLayout's watcher on it then makes has to answer with the delegated grants
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site1', title: 'Site 1' }]) }
      }
      if (typeof url === 'string' && url.endsWith('/userPermissions')) {
        return { json: () => Promise.resolve(sitePermissions) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const router = await createTestRouter(['/_admin/:siteid/general'], '/_admin/site1/general')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: permissions }, flags: { experimental: experimental } }
    })
    await flushPromises()

    return wrapper
  }

  function findItemByIcon(wrapper, iconName) {
    return wrapper
      .findAll('.w-item')
      .find((item) => item.find(`[data-icon="${iconName}"]`).exists())
  }

  it('shows the Comments link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const commentsItem = findItemByIcon(wrapper, 'tabler:message')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
    // -> A disabled `to` item is not a `router-link`, so the tag name is the enabled/disabled tell
    expect(commentsItem.element.tagName).toBe('A')
  })

  it('shows the Analytics link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const analyticsItem = findItemByIcon(wrapper, 'tabler:chart-line')

    expect(analyticsItem).toBeDefined()
    expect(analyticsItem.attributes('aria-disabled')).toBeUndefined()
    expect(analyticsItem.element.tagName).toBe('A')
  })

  it('keeps the Comments link visible when the experimental flag is on too', async () => {
    const wrapper = await mountLayout({ experimental: true })

    const commentsItem = findItemByIcon(wrapper, 'tabler:message')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
  })

  /**
   * Both pages require `manage:sites` server-side, so a link an actor without it can see is a 403
   * over an empty page.
   */
  it('hides Analytics and Comments from a delegated admin who lacks manage:sites', async () => {
    const wrapper = await mountLayout({
      experimental: false,
      permissions: ['access:admin'],
      // -> An arbitrary delegated `site:*` grant, so this actor has SOME site access, just not the
      //    group-wide permission these two links need
      sitePermissions: ['site:theme']
    })

    expect(findItemByIcon(wrapper, 'tabler:chart-line')).toBeUndefined()
    expect(findItemByIcon(wrapper, 'tabler:message')).toBeUndefined()
  })
})

describe('AdminLayout Navigation nav-tree entry', () => {
  async function mountLayout({ permissions = [], experimental = false } = {}) {
    const router = await createTestRouter(['/:pathMatch(.*)*'], '/_admin/site-1/navigation')

    return mountWithApp(AdminLayout, {
      router,
      stores: {
        user: { permissions: permissions },
        flags: (store) => {
          store.$patch({ loaded: true, experimental })
        },
        admin: { currentSiteId: 'site-1' }
      }
    }).wrapper
  }

  function findNavigationLink(wrapper) {
    return wrapper.find('a[href="/_admin/site-1/navigation"]')
  }

  it('shows the entry, not disabled, when the user has manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:navigation'], experimental: false })

    const link = findNavigationLink(wrapper)

    expect(link.exists()).toBe(true)
    expect(link.attributes('aria-disabled')).toBeUndefined()
  })

  it('hides the entry for manage:sites alone -- the backend has never accepted it for navigation', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:sites'], experimental: false })

    expect(findNavigationLink(wrapper).exists()).toBe(false)
  })

  it('shows the entry for a delegated site:navigation grant on the current site, without manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: [], experimental: false })
    const userStore = useUserStore()
    userStore.sitePermissions = ['site:navigation']
    userStore.sitePermissionsSiteId = 'site-1'
    await wrapper.vm.$nextTick()

    expect(findNavigationLink(wrapper).exists()).toBe(true)
  })

  it('hides the entry when the user has neither manage:sites nor manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: [], experimental: true })

    expect(findNavigationLink(wrapper).exists()).toBe(false)
  })
})

/**
 * TLS terminates at a reverse proxy or ingress here, never in-app, so there is no certificate
 * management screen to restore -- these keep the deleted surface from growing back.
 */
describe('AdminLayout SSL dead-code removal', () => {
  const adminLayoutPath = join(import.meta.dirname, 'AdminLayout.vue')
  const adminSslPagePath = join(import.meta.dirname, '../pages/AdminSsl.vue')
  const sslIconPath = join(
    import.meta.dirname,
    '../../public/_assets/icons/fluent-security-ssl.svg'
  )
  const localesPath = join(import.meta.dirname, '../../../backend/locales/en.json')

  it('does not reference the removed /_admin/ssl route or AdminSsl.vue', () => {
    const source = readFileSync(adminLayoutPath, 'utf-8')
    expect(source).not.toContain('/_admin/ssl')
    expect(source).not.toContain('admin.ssl.')
    expect(source).not.toContain('fluent-security-ssl')
  })

  it('no longer ships frontend/src/pages/AdminSsl.vue', () => {
    expect(existsSync(adminSslPagePath)).toBe(false)
  })

  it('no longer ships the now-unreferenced SSL nav icon asset', () => {
    expect(existsSync(sslIconPath)).toBe(false)
  })

  it('no longer carries any admin.ssl.* locale keys', () => {
    const locales = JSON.parse(readFileSync(localesPath, 'utf-8'))
    const sslKeys = Object.keys(locales).filter((key) => key.startsWith('admin.ssl.'))
    expect(sslKeys).toEqual([])
  })
})

/**
 * The language switcher is the control a reader uses to switch INTO an RTL locale, and this header
 * stays mounted across navigations -- so its anchor has to mirror reactively off
 * `composables/direction.js`, not be resolved once at mount.
 */
async function mountAdminLayout() {
  setActivePinia(createPinia())
  useUserStore().$patch({ permissions: ['manage:system'] })

  const router = await createTestRouter(
    ['/_admin/:siteid?/:rest*', '/_error/unauthorized'],
    '/_admin/site-1/dashboard'
  )

  const i18n = createTestI18n()

  // -> `onMounted` calls `fetchSites()`, and only a non-empty list gives it a `currentSiteId`
  stubApi({ sites: [{ id: 'site-1', title: 'Test Site' }] }, { fallback: [] })

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
    // -> `useDirection`'s backing ref is module-level state; left flipped it bleeds into the next test
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

describe('AdminLayout toolbar hover treatment (task 822)', () => {
  async function mountToolbar() {
    setActivePinia(createPinia())
    useUserStore().$patch({ permissions: ['manage:system'] })

    const router = await createTestRouter(
      ['/_admin/:siteid?/:rest*', '/_error/unauthorized'],
      '/_admin/site-1/dashboard'
    )

    const i18n = createTestI18n()

    stubApi({ sites: [{ id: 'site-1', title: 'Test Site' }] }, { fallback: [] })

    const wrapper = mount(AdminLayout, {
      global: {
        plugins: [router, i18n],
        stubs: { 'router-view': true, FooterNav: true }
      }
    })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  function findButtonByIcon(wrapper, iconName) {
    return wrapper.findAll('.w-btn').find((btn) => btn.find(`[data-icon="${iconName}"]`).exists())
  }

  /*
    These two sit off the `header-nav-btn` band: that band is a hover fill made for a solid dark bar,
    and on the admin header's white plate a control needs an edge of its own to read as one.
  */
  it('outlines the EXIT button, in the accent -- the one control in the bar that leaves', async () => {
    const wrapper = await mountToolbar()

    const exitBtn = findButtonByIcon(wrapper, 'tabler:circle-x')

    expect(exitBtn).toBeDefined()
    expect(exitBtn.classes()).not.toContain('header-nav-btn')
    expect(exitBtn.classes()).toContain('border')
    expect(exitBtn.attributes('style')).toContain('var(--color-accent)')
  })

  it('outlines the locale switcher too, in the chrome tone', async () => {
    const wrapper = await mountToolbar()

    const localeBtn = findButtonByIcon(wrapper, 'tabler:language')

    expect(localeBtn).toBeDefined()
    expect(localeBtn.classes()).not.toContain('header-nav-btn')
    expect(localeBtn.classes()).toContain('border')
    expect(localeBtn.attributes('style')).toContain('var(--color-slate)')
  })

  // -> The shared class is how an aesthetic restrokes these: a WBtn's `color` never reaches its border
  it('gives both the Exit and locale-switcher buttons the admin-header-action-btn class', async () => {
    const wrapper = await mountToolbar()

    const exitBtn = findButtonByIcon(wrapper, 'tabler:circle-x')
    const localeBtn = findButtonByIcon(wrapper, 'tabler:language')

    expect(exitBtn.classes()).toContain('admin-header-action-btn')
    expect(localeBtn.classes()).toContain('admin-header-action-btn')
  })

  it('keeps the account-menu button on the shared header-nav-btn treatment too, for a flush group', async () => {
    const wrapper = await mountToolbar()

    const accountBtn = wrapper.find('.account-avbtn')

    expect(accountBtn.exists()).toBe(true)
    expect(accountBtn.classes()).toContain('header-nav-btn')
    expect(accountBtn.classes()).toContain('flush-hover-btn')
  })

  it('no longer declares the header-nav-btn--auto-width modifier, which has no callers left', () => {
    // -> Vue Test Utils never loads the app's stylesheet, so no mounted assertion can see a dead rule
    const dir = dirname(fileURLToPath(import.meta.url))
    const scssPath = join(dir, '../css/_base.css')
    const source = readFileSync(scssPath, 'utf-8')

    expect(source).not.toMatch(/header-nav-btn--auto-width/)
  })
})

/**
 * The `admin-overlay` dialog takes its accessible name from `ADMIN_OVERLAY_TITLES`, keyed by which
 * `overlays` child is loaded, since the child owns the only visible heading. A key in one map and
 * not the other leaves that screen's dialog unnamed with no visible symptom.
 */
describe('AdminLayout admin-overlay accessible-name map', () => {
  function topLevelKeys(source, constName) {
    const declStart = source.indexOf(`const ${constName} = {`)
    if (declStart === -1) {
      throw new Error(`const ${constName} not found in AdminLayout.vue`)
    }
    const braceStart = source.indexOf('{', declStart)
    let depth = 0
    let braceEnd = -1
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++
      if (source[i] === '}') {
        depth--
        if (depth === 0) {
          braceEnd = i
          break
        }
      }
    }
    // -> Strip line comments first: a commented-out entry would otherwise read as a real key
    const body = source
      .slice(braceStart + 1, braceEnd)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const keys = []
    const keyPattern = /(\w+):/g
    let match
    while ((match = keyPattern.exec(body))) {
      const before = body.slice(0, match.index)
      const opens = (before.match(/[{(]/g) || []).length
      const closes = (before.match(/[})]/g) || []).length
      if (opens - closes === 0) {
        keys.push(match[1])
      }
    }
    return keys.sort()
  }

  it('ADMIN_OVERLAY_TITLES covers exactly the same keys as overlays', () => {
    const source = readFileSync(join(import.meta.dirname, 'AdminLayout.vue'), 'utf-8')

    expect(topLevelKeys(source, 'ADMIN_OVERLAY_TITLES')).toEqual(topLevelKeys(source, 'overlays'))
  })
})

/**
 * `siteStore.openOverlay()` only ever renders through `<MainOverlayDialog>`, so an admin page
 * calling it without this mounted sets the store field and shows nothing -- a dead click. Distinct
 * from the layout's own `adminStore.overlay`-driven dialog, which is a separate mechanism.
 */
describe('AdminLayout MainOverlayDialog mount (OpenProject #2564)', () => {
  it('mounts MainOverlayDialog, so a siteStore.openOverlay() call from an admin page has something to render into', async () => {
    const router = await createTestRouter(['/_admin/:siteid?/:rest*'], '/_admin/site-1/dashboard')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: ['manage:system'] } }
    })
    await flushPromises()

    expect(wrapper.findComponent(MainOverlayDialog).exists()).toBe(true)
  })
})

describe('AdminLayout system nav icons (OpenProject #2831)', () => {
  async function mountSystemNav() {
    const router = await createTestRouter(['/_admin/:siteid?/:rest*'], '/_admin/site-1/dashboard')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: ['manage:system'] } }
    })
    await flushPromises()

    return wrapper
  }

  it("matches Profile's tabler:api icon on the API Access nav entry", async () => {
    const wrapper = await mountSystemNav()

    const apiItem = wrapper.find('a[href="/_admin/api"]')
    expect(apiItem.exists()).toBe(true)
    expect(apiItem.find('[data-icon="tabler:api"]').exists()).toBe(true)
    expect(apiItem.find('[data-icon="tabler:plug-connected"]').exists()).toBe(false)
  })

  it('uses a timer-related icon, not the robot, on the Scheduler nav entry', async () => {
    const wrapper = await mountSystemNav()

    const schedulerItem = wrapper.find('a[href="/_admin/scheduler"]')
    expect(schedulerItem.exists()).toBe(true)
    expect(schedulerItem.find('[data-icon="tabler:clock-play"]').exists()).toBe(true)
    expect(schedulerItem.find('[data-icon="tabler:robot"]').exists()).toBe(false)
  })
})

/**
 * Working SMTP is not enough: without a base URL every link the instance mails out resolves
 * nowhere, so that half warns as loudly as an unconfigured mailer.
 */
describe('AdminLayout mail status light (OpenProject #3386)', () => {
  async function mountMailNav(info) {
    // -> `onMounted`'s `fetchInfo()` overwrites `info.*`, so seed the response, not the store
    stubApi(
      { sites: [{ id: 'site-1', title: 'Test Site' }], 'system/info': info },
      { fallback: [] }
    )

    const router = await createTestRouter(['/_admin/:siteid?/:rest*'], '/_admin/site-1/dashboard')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: ['manage:system'] } }
    })
    await flushPromises()

    return wrapper
  }

  function mailStatusLight(wrapper) {
    const mailItem = wrapper.find('a[href="/_admin/mail"]')
    expect(mailItem.exists()).toBe(true)
    return mailItem.find('.status-light')
  }

  it('is positive, not pulsing, once both SMTP and the base URL are configured', async () => {
    const wrapper = await mountMailNav({
      isMailConfigured: true,
      isMailBaseURLConfigured: true
    })

    const light = mailStatusLight(wrapper)
    expect(light.classes()).toContain('positive')
    expect(light.classes()).not.toContain('pulsate')
  })

  it('warns when SMTP is configured but the base URL is not resolvable', async () => {
    const wrapper = await mountMailNav({
      isMailConfigured: true,
      isMailBaseURLConfigured: false
    })

    const light = mailStatusLight(wrapper)
    expect(light.classes()).toContain('warning')
    expect(light.classes()).toContain('pulsate')
  })

  it('warns when the base URL is resolvable but SMTP is not configured', async () => {
    const wrapper = await mountMailNav({
      isMailConfigured: false,
      isMailBaseURLConfigured: true
    })

    const light = mailStatusLight(wrapper)
    expect(light.classes()).toContain('warning')
    expect(light.classes()).toContain('pulsate')
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
    expect(styleBlock).toMatch(/border-inline-end-color\s*:\s*var\(--color-positive-fill\)/)
  })
})

/**
 * The admin mockups still draw a "beta" chip beside the area label. Its absence here is a deliberate
 * divergence, so a conformance pass against those mockups should leave it absent.
 */
describe('AdminLayout beta badge removal (OpenProject #2635)', () => {
  it('renders no "beta" badge in the admin header', async () => {
    const router = await createTestRouter(['/_admin/:siteid?/:rest*'], '/_admin/site-1/dashboard')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: ['manage:system'] } }
    })
    await flushPromises()

    const header = wrapper.find('.admin-header')
    expect(header.exists()).toBe(true)
    expect(header.text().toLowerCase()).not.toContain('beta')
  })

  /*
    Scoped to the centred toolbar, not the whole template: the sidebar's nav counts are `<w-badge>`s
    too, so a blanket "no badge anywhere" assertion would guard the wrong thing.
  */
  it('leaves the centred toolbar holding the area label alone, with no badge beside it', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const template = source.slice(0, source.indexOf('</template>'))

    const start = template.indexOf('<w-toolbar class="max-md:hidden justify-center"')
    expect(start).toBeGreaterThan(-1)
    const centredToolbar = template.slice(start, template.indexOf('</w-toolbar>', start))

    expect(centredToolbar).toMatch(/<div class="admin-area-label">/)
    expect(centredToolbar).not.toMatch(/<w-badge/)
    expect(template).not.toMatch(/label="beta"/i)
  })
})

/**
 * `header-nav-btn`'s `!important` padding overrides everything `dense` does, so carrying both says
 * two different things about one button and only one of them is true.
 */
describe('AdminLayout home-link button padding (OpenProject #3069)', () => {
  it('gives the home-link button the header-nav-btn class, matching HeaderNav.vue', async () => {
    const router = await createTestRouter(['/_admin/:siteid?/:rest*'], '/_admin/site-1/dashboard')

    const { wrapper } = mountWithApp(AdminLayout, {
      router,
      stores: { user: { permissions: ['manage:system'] } }
    })
    await flushPromises()

    const homeLink = wrapper.find(`a[href="/"].header-nav-btn`)
    expect(homeLink.exists()).toBe(true)
  })

  it('drops the redundant dense prop off the home-link button', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const template = source.slice(0, source.indexOf('</template>'))

    const homeButtonMatch = template.match(/<w-btn[^>]*to="\/"[^>]*common\.header\.home[^>]*>/)
    expect(homeButtonMatch).not.toBeNull()
    expect(homeButtonMatch[0]).toContain('header-nav-btn')
    expect(homeButtonMatch[0]).not.toMatch(/\bdense\b/)
  })
})

/**
 * Source text rather than computed style: the test DOM does not resolve an aesthetic's `var()`
 * cascade reliably. These assert only that the overrides exist, stay scoped to `body.body--cobalt`
 * and read the right custom properties -- the token values themselves are `cobaltTokens.test.js`'s.
 */
describe('AdminLayout Cobalt aesthetic overrides (OpenProject #2780)', () => {
  function cobaltOverrideBlock() {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    const start = styleBlock.indexOf('body.body--cobalt {')
    expect(start).toBeGreaterThan(-1)
    return styleBlock.slice(start)
  }

  it('gives the admin header the site header-bar colour instead of a fixed white plate', () => {
    const block = cobaltOverrideBlock()

    expect(block).toMatch(/\.admin-header\s*\{[^}]*background-color:\s*var\(--q-header\)/)
    expect(block).toMatch(/\.admin-header\s*\{[^}]*color:\s*var\(--color-white\)/)
  })

  it('gives the admin sidebar its own distinct, non-inheriting Cobalt token set', () => {
    const block = cobaltOverrideBlock()
    const start = block.indexOf('.admin-sidebar {')
    expect(start).toBeGreaterThan(-1)
    const sidebar = block.slice(start, block.indexOf('\n}', start))

    expect(sidebar).toMatch(/background-color:\s*var\(--color-admin-sidebar-bg\)/)
    expect(sidebar).toMatch(/border-inline-end-color:\s*var\(--color-admin-sidebar-hairline\)/)
    expect(sidebar).toMatch(/color:\s*var\(--color-admin-sidebar-text\)/)
    expect(sidebar).toMatch(/color:\s*var\(--color-admin-sidebar-icon\)/)
    expect(sidebar).toMatch(/background-color:\s*var\(--color-admin-sidebar-raised\)/)
  })

  it('marks the active nav row in the aesthetic-aware accent fill, not a fixed SCSS tone', () => {
    const block = cobaltOverrideBlock()

    expect(block).toMatch(
      /\.admin-nav-active\s*\{[^}]*border-inline-start-color:\s*var\(--color-accent-fill\)/
    )
  })

  it("overrides the nav count badges' inline style, keeping the frozen StatusLight stripe alone", () => {
    const block = cobaltOverrideBlock()
    const start = block.indexOf('.count-badge {')
    expect(start).toBeGreaterThan(-1)
    const countBadge = block.slice(start, block.indexOf('\n    }', start))

    expect(countBadge).toMatch(
      /background-color:\s*var\(--color-admin-sidebar-raised\)\s*!important/
    )
    expect(countBadge).toMatch(/color:\s*var\(--color-sidebar-text-secondary\)\s*!important/)
    // -> The trailing-edge stripe stays put: it has to match StatusLight, a frozen shared primitive
    //    that keeps its negative/positive fills whatever the aesthetic
    expect(countBadge).not.toMatch(/negative-fill|positive-fill/)
  })

  it('gives the page eyebrow the admin-editable accent colour, light and dark', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).toMatch(
      /body\.body--cobalt\s*\{[\s\S]*?\.admin-page-eyebrow\s*\{\s*color:\s*var\(--color-accent\);/
    )
    expect(styleBlock).toMatch(
      /body\.body--cobalt\.body--dark\s*\{\s*\.admin-page-eyebrow\s*\{\s*color:\s*var\(--color-accent-dark\);/
    )
  })

  it('reads the Contribute button border off the same custom property as its Ledger value', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'AdminLayout.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).toMatch(
      /\.admin-contribute-btn\s*\{\s*border-color:\s*var\(--color-accent-fill\)\s*!important;/
    )
  })

  // -> One rule, no light/dark split: plain white reads on both Cobalt modes' header bars
  it('gives the header action buttons a solid white stroke and border (OpenProject #3001)', () => {
    const block = cobaltOverrideBlock()

    expect(block).toMatch(
      /\.admin-header-action-btn\s*\{\s*border-color:\s*#fff\s*!important;\s*color:\s*#fff\s*!important;/
    )
  })
})
