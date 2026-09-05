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
  `stores/common.js` reads `localStorage.getItem('locale')` at store-creation time. Node 26 (this
  repo's engine requirement) ships an experimental global `localStorage` that shadows happy-dom's own
  implementation in a way that leaves `.getItem` missing -- nothing under test actually cares about a
  persisted locale, so a minimal stub sidesteps the collision rather than fighting over which
  `localStorage` wins. `AdminLayout` pulls in `commonStore` unconditionally, so any mount needs this.
*/
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  })
})

describe('AdminLayout sidebar nav', () => {
  /**
   * Regression coverage for Task 614 (Feature 394, "Admin comments management UI rebuild"): the
   * sidebar Comments link used to be permanently `disabled` and only ever rendered behind
   * `flagsStore.experimental`, alongside Analytics. Both of those gates are gone -- the link is a
   * normal, clickable admin nav entry, matching General/Approvals -- but (OpenProject #950) it is
   * now gated on `manage:sites` the way General/Approvals already were, which every test in THIS
   * describe block grants by default; see the separate "delegated admin" describe block below for
   * coverage of a user who does not hold it.
   */
  async function mountLayout({
    experimental,
    permissions = ['access:admin', 'manage:sites'],
    sitePermissions = []
  }) {
    // -> Avoids the pre-existing `this.sites[0].id` crash in `adminStore.fetchSites()` (called from
    //    `onMounted`) when the stubbed API_CLIENT response is empty by default. The
    //    `userPermissions` branch avoids a similar crash in `userStore.fetchSitePermissions()`,
    //    triggered by AdminLayout.vue's watcher on `adminStore.currentSiteId` once `fetchSites()`
    //    resolves — `sitePermissions.includes()` needs an array, not the default `undefined`.
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

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
    // -> A non-disabled `to` item renders as a `router-link` -> `<a>`, with the real target href.
    expect(commentsItem.element.tagName).toBe('A')
  })

  it('shows the Analytics link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const analyticsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-bar-chart.svg')

    expect(analyticsItem).toBeDefined()
    expect(analyticsItem.attributes('aria-disabled')).toBeUndefined()
    expect(analyticsItem.element.tagName).toBe('A')
  })

  it('keeps the Comments link visible when the experimental flag is on too', async () => {
    const wrapper = await mountLayout({ experimental: true })

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
  })

  /**
   * OpenProject #950: unlike the other eight site-scoped sidebar entries (General, Approvals,
   * Blocks, Editors, Locale, Login, Navigation, Theme -- each gated via `maySeeSiteSurface`/
   * `manage:sites`), Analytics and Comments rendered for anyone holding `access:admin` at all, no
   * `v-if`. Both pages require `manage:sites` server-side (`backend/api/analytics.ts`,
   * `backend/api/comments.ts`'s admin routes), so a delegated administrator holding only a `site:*`
   * permission -- `site:theme` here, an arbitrary one of the eight the other entries already gate on
   * -- saw both links and got a 403 error toast over an empty page on click.
   */
  it('hides Analytics and Comments from a delegated admin who lacks manage:sites', async () => {
    const wrapper = await mountLayout({
      experimental: false,
      permissions: ['access:admin'],
      // -> `site:theme` is a per-site DELEGATED permission (`userStore.canOnSite`, fetched from
      //    `sites/:id/userPermissions`), not a group-wide one -- an arbitrary one of the eight
      //    `site:*` surfaces the other sidebar entries already gate on, chosen to prove this admin
      //    genuinely has SOME delegated access, just not the `manage:sites` these two links need.
      sitePermissions: ['site:theme']
    })

    expect(findItemByIcon(wrapper, 'img:/_assets/icons/fluent-bar-chart.svg')).toBeUndefined()
    expect(findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')).toBeUndefined()
  })
})

describe('AdminLayout Navigation nav-tree entry', () => {
  /**
   * Regression test for the Navigation nav-tree entry's gating (Feature 358, Task 434): it used to be
   * wrapped in `flagsStore.experimental &&` and carry a `disabled` attribute, back when the screen
   * behind it (`AdminNavigation.vue`) was a dead stub. Both are gone now that the screen is real — the
   * entry should behave exactly like every other admin nav-tree item, gated on the permission check
   * alone, regardless of the experimental flag.
   */
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
 * Regression guard for the AdminSsl.vue removal (Task 599, Feature 388).
 *
 * `AdminSsl.vue` was unrouted dead code: a pre-migration Options-API/Pug page wired to
 * `$apollo.mutate` calls (`system.setHTTPSRedirection`, `system.renewHTTPSCertificate`) that have no
 * backend implementation, reachable only through a `disabled` nav item this file rendered behind
 * `flagsStore.experimental` -- `frontend/src/router/routes.js` never defined an `ssl` route, so the
 * link never resolved to anything even with the flag on.
 *
 * 3.0's TLS posture is termination at a reverse proxy/ingress (see the `trustProxy` setting in
 * `AdminSecurity.vue` and the Docker/Helm assets under `dev/`), not in-app certificate management --
 * so the page, its nav entry, and its locale strings were deleted outright rather than rebuilt, per
 * this repo's CLAUDE.md ("change the shape, change the callers, and delete the old path"). These
 * assertions exist to keep that dead surface from quietly growing back.
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

  const router = await createTestRouter(
    ['/_admin/:siteid?/:rest*', '/_error/unauthorized'],
    '/_admin/site-1/dashboard'
  )

  const i18n = createTestI18n()

  // -> `fetchSites()` (called from `onMounted`) does `this.sites[0].id` when nothing came back --
  //    the default `API_CLIENT` stub resolves every call to `undefined`, which would throw. A
  //    stubbed site list is what a real backend would return here.
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

/**
 * Regression coverage for task 822: the EXIT and locale-switcher buttons in the admin toolbar used
 * to carry only `ml-4` (WBtn's default `hover:bg-current/10` fill), the same faint/inconsistent
 * hover state task 807 fixed for the site header's five icon buttons via `.header-nav-btn`. These
 * two buttons carry a visible text label beside their icon, unlike those five icon-only buttons, so
 * they take `header-nav-btn` together with the `header-nav-btn--auto-width` modifier
 * (`css/_base.scss`) rather than the bare class -- same 64px band, squared corners and 20% hover
 * fill, but sized to the label instead of forced to a 64px square.
 */
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
    The Cardinal re-skin moved these two off the `header-nav-btn` band. That band is a hover FILL on a
    solid dark bar, and the admin header is a white plate now -- so a control needs an edge of its
    own to read as one, which is what `outline` gives it. `header-nav-btn--auto-width` existed only
    to let these two size to their labels inside that band, and went with them.
  */
  it('outlines the EXIT button, in the accent -- the one control in the bar that leaves', async () => {
    const wrapper = await mountToolbar()

    const exitBtn = findButtonByIcon(wrapper, 'la:times-circle')

    expect(exitBtn).toBeDefined()
    expect(exitBtn.classes()).not.toContain('header-nav-btn')
    expect(exitBtn.classes()).toContain('border')
    expect(exitBtn.attributes('style')).toContain('var(--color-accent)')
  })

  it('outlines the locale switcher too, in the chrome tone', async () => {
    const wrapper = await mountToolbar()

    const localeBtn = findButtonByIcon(wrapper, 'la:language')

    expect(localeBtn).toBeDefined()
    expect(localeBtn.classes()).not.toContain('header-nav-btn')
    expect(localeBtn.classes()).toContain('border')
    expect(localeBtn.attributes('style')).toContain('var(--color-slate)')
  })

  it('keeps the account-menu button on the shared header-nav-btn treatment too, for a flush group', async () => {
    const wrapper = await mountToolbar()

    const accountBtn = wrapper.find('.account-avbtn')

    expect(accountBtn.exists()).toBe(true)
    expect(accountBtn.classes()).toContain('header-nav-btn')
  })

  it('no longer declares the header-nav-btn--auto-width modifier, which has no callers left', () => {
    // -> Vue Test Utils never loads the app's stylesheet, so the class assertions above cannot catch
    //    a dead rule left behind in the CSS. Guards the removal directly, the same way the SSL
    //    dead-code describe block above asserts on file contents rather than rendered style.
    const dir = dirname(fileURLToPath(import.meta.url))
    const scssPath = join(dir, '../css/_base.scss')
    const source = readFileSync(scssPath, 'utf-8')

    expect(source).not.toMatch(/header-nav-btn--auto-width/)
  })
})

/**
 * OpenProject #2356: the admin `admin-overlay` `<w-dialog>` gets its accessible name from a small
 * lookup map (`ADMIN_OVERLAY_TITLES`) keyed by which child `overlays` component is currently loaded --
 * there is no title of its own to read, since the loaded child owns the only visible heading. A key
 * present in one map but not the other is exactly the failure mode that would silently leave that one
 * screen's dialog unnamed with no visible symptom, so this guards the two maps staying in lockstep
 * rather than asserting against a full, heavier mount of each real (dynamically-imported) child
 * overlay (`EditorMarkdownConfigOverlay`, `GroupEditOverlay`, `UserEditOverlay`).
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
    // -> Strips `//`-to-end-of-line comments first: a commented-out entry in either map (an overlay
    //    that is not yet implemented, say) would otherwise still be picked up as a real key by a
    //    purely textual `\w+:` scan.
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
 * Regression coverage for OpenProject #2564: `AdminApi.vue`'s personal-token note opens the shared
 * "Profile" overlay via `siteStore.openOverlay('Profile', { section: 'api' })`, but that overlay is
 * only ever rendered by `<MainOverlayDialog>` -- which, unlike `MainLayout.vue`
 * (`frontend/src/layouts/MainLayout.vue:207`), `AdminLayout.vue` never mounted. The click set
 * `siteStore.overlay`/`overlayOpts` with nothing in the admin view able to render it: a dead click.
 * This does not overlap `AdminLayout`'s own separate `adminStore.overlay`-driven `<w-dialog>`
 * (EditorMarkdownConfig/GroupEditOverlay/UserEditOverlay) -- a distinct store field and mechanism.
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
