import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminStorage from './AdminStorage.vue'
import { useDark } from '@/composables/dark'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/**
 * Regression coverage for the orphaned GitHub App setup flow that used to live in this page
 * (task 509, Feature 372): `setupGitHub()` / `setupGitHubStep()` posted a manifest to
 * github.com and drove a multi-step OAuth+webhook install, but nothing on the backend ever backed
 * it -- no `modules/storage/github/definition.yml` declared the `setup.handler`, no `/_github/*`
 * webhook route existed, so `state.target.setup.handler` could never actually equal `'github'` at
 * runtime and the whole branch (template blocks, JS handlers, the manifest-form ref, and the
 * `GithubSetupInstallDialog.vue` popup) was unreachable dead code. It was removed rather than
 * finished, since a real GitHub App storage module is new 3.0-native scope for its own Feature, not
 * something to half-build inside this git-parity task.
 *
 * These assertions read the page's source text directly rather than mounting it: `AdminStorage.vue`
 * pulls in the admin/site stores and live storage-target API calls that no other Admin* page
 * currently has Vitest coverage driving through, so a full mount here would be a disproportionate
 * lift for what is fundamentally a "this dead code must not silently reappear" check. The
 * v-network-graph delivery-path diagram (task #1888) has its own, separate mount-based coverage below
 * instead, since that one specifically needs to prove the diagram still renders once the library is
 * registered locally rather than globally.
 */

const pagePath = join(import.meta.dirname, 'AdminStorage.vue')
const pageSource = readFileSync(pagePath, 'utf8')

const localePath = join(import.meta.dirname, '../../../backend/locales/en.json')
const locale = JSON.parse(readFileSync(localePath, 'utf8'))

describe('AdminStorage.vue - GitHub App setup flow removal', () => {
  it('does not reference any of the removed GitHub-specific setup handlers or state', () => {
    for (const removed of [
      'setupGitHub(',
      'setupGitHubStep(',
      'githubSetupForm',
      'state.setupCfg',
      'GithubSetupInstallDialog',
      'handleSetupCallback'
    ]) {
      expect(pageSource).not.toContain(removed)
    }
  })

  it('does not gate any template block on a github setup handler', () => {
    expect(pageSource).not.toMatch(/setup\.handler\s*===\s*[`'"]github[`'"]/)
  })

  it('deleted the GithubSetupInstallDialog.vue component it used to open', () => {
    const dialogPath = join(import.meta.dirname, '../components/GithubSetupInstallDialog.vue')
    expect(existsSync(dialogPath)).toBe(false)
  })

  it('has a locale entry for every admin.storage.* key it still calls t() with', () => {
    const used = new Set(pageSource.match(/admin\.storage\.[A-Za-z0-9]+/g))
    expect(used.size).toBeGreaterThan(0)

    const missing = [...used].filter((key) => !(key in locale))
    expect(missing).toEqual([])
  })
})

/**
 * Task #1888: v-network-graph used to be registered globally in `boot/components.js` (and its
 * stylesheet globally in `css/app.scss`), even though this page is its sole consumer. Both are now
 * registered locally here instead -- this is the regression coverage proving the delivery-path
 * diagram still renders with no global registration in the picture.
 */
async function mountPage() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const userStore = useUserStore()
  userStore.permissions = ['manage:system']

  globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve([]) })

  const router = buildTestRouter(['/:pathMatch(.*)*'])
  const i18n = createTestI18n()

  const wrapper = mount(AdminStorage, { global: { plugins: [router, i18n] } })
  await flushPromises()

  return wrapper
}

/** Switches an already-mounted page into the delivery-paths display mode and returns the
 *  `<v-network-graph>` wrapper once it has rendered its own DOM. */
async function switchToDeliveryGraph(wrapper) {
  const deliveryToggle = wrapper
    .findAll('button')
    .find((b) => b.text() === 'admin.storage.deliveryPaths')
  expect(deliveryToggle).toBeDefined()

  await deliveryToggle.trigger('click')
  await flushPromises()

  return wrapper.find('.v-network-graph')
}

describe('AdminStorage.vue - v-network-graph local registration', () => {
  it('renders the delivery-path diagram once switched to that display mode', async () => {
    const wrapper = await mountPage()

    // -> Not rendered yet: default displayMode is `targets`, the diagram is behind a v-if
    expect(wrapper.find('.v-network-graph').exists()).toBe(false)

    const graph = await switchToDeliveryGraph(wrapper)
    expect(graph.exists()).toBe(true)
    // -> The library's own root class from its stylesheet -- proves the locally-registered
    //    component actually mounted and rendered its DOM, not just that the wrapper element exists.
    expect(graph.classes()).toContain('v-network-graph')
    // -> generateGraph() always seeds at least the `user`/`pages`/`pages_wiki` nodes plus one node
    //    per content type -- confirms the component received real node data, not an empty graph.
    expect(graph.findAll('.v-ng-node').length).toBeGreaterThan(0)
  })
})

/**
 * OpenProject #2500: the delivery-paths graph used to hardcode `style="background-color: #fff"`,
 * rendering as a stark white box inside an otherwise dark-themed admin page. It's now bound to
 * `useDark()`'s `dark.isActive` -- the same composable already driving every other dark-mode-aware
 * control on this page -- so these assert both the actual rendered background AND the node label
 * color: leaving the label at the library's default black would trade one bug (a mismatched white
 * panel) for a worse one (unreadable black-on-dark text) the moment the background goes dark.
 */
describe('AdminStorage.vue - delivery-path diagram dark mode (OpenProject #2500)', () => {
  afterEach(() => {
    // `useDark()`'s `active` ref is a module-level singleton -- reset it so a test that turned
    // dark mode on doesn't leak into an unrelated test running later in this file.
    useDark().set(false)
  })

  it('keeps the light background and the library default black label in light mode', async () => {
    useDark().set(false)
    const wrapper = await mountPage()
    const graph = await switchToDeliveryGraph(wrapper)

    expect(graph.attributes('style')).toMatch(/background-color:\s*#fff/)

    const label = graph.find('.v-ng-text')
    expect(label.exists()).toBe(true)
    expect(label.attributes('fill')).toBe('#000000')
  })

  it('switches to the dark card surface and a light label color in dark mode', async () => {
    useDark().set(true)
    const wrapper = await mountPage()
    const graph = await switchToDeliveryGraph(wrapper)

    const style = graph.attributes('style')
    expect(style).toContain('background-color')
    expect(style).not.toMatch(/background-color:\s*#fff/)

    const label = graph.find('.v-ng-text')
    expect(label.exists()).toBe(true)
    expect(label.attributes('fill')).toBe('#e8eaed')
  })
})
