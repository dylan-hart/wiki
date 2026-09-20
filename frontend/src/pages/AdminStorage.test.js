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
 * The GitHub-setup assertions below read the page's source text rather than mounting it: they guard
 * against unreachable dead code reappearing, and a mount would have to stand up the admin/site
 * stores and live storage-target calls to prove nothing.
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

async function switchToDeliveryGraph(wrapper) {
  const deliveryToggle = wrapper
    .findAll('button')
    .find((b) => b.text() === 'admin.storage.deliveryPaths')
  expect(deliveryToggle).toBeDefined()

  await deliveryToggle.trigger('click')
  await flushPromises()

  return wrapper.find('.storage-delivery-graph')
}

describe('AdminStorage.vue - delivery-path diagram (StorageDeliveryGraph.vue, task #3116)', () => {
  it('renders the delivery-path diagram once switched to that display mode', async () => {
    const wrapper = await mountPage()

    // -> Default `displayMode` is `targets`, and the diagram is behind a v-if
    expect(wrapper.find('.storage-delivery-graph').exists()).toBe(false)

    const graph = await switchToDeliveryGraph(wrapper)
    expect(graph.exists()).toBe(true)
    // -> The node count is data-dependent; a non-empty list is what proves real graph data arrived.
    expect(graph.findAll('.storage-delivery-graph__node').length).toBeGreaterThan(0)
  })
})

/**
 * The node label colour is asserted alongside the background: a dark background with the label left
 * black would trade a mismatched white panel for unreadable black-on-dark text.
 */
describe('AdminStorage.vue - delivery-path diagram dark mode (OpenProject #2500)', () => {
  afterEach(() => {
    // `useDark()`'s `active` ref is a module-level singleton, so dark mode leaks into later tests.
    useDark().set(false)
  })

  it('keeps the light background and a black label in light mode', async () => {
    useDark().set(false)
    const wrapper = await mountPage()
    const graph = await switchToDeliveryGraph(wrapper)

    expect(graph.find('.storage-delivery-graph__background').attributes('fill')).toBe('#fff')

    const label = graph.find('.storage-delivery-graph__label')
    expect(label.exists()).toBe(true)
    expect(label.attributes('fill')).toBe('#000000')
  })

  it('switches to the dark card surface and a light label color in dark mode', async () => {
    useDark().set(true)
    const wrapper = await mountPage()
    const graph = await switchToDeliveryGraph(wrapper)

    expect(graph.find('.storage-delivery-graph__background').attributes('fill')).toBe(
      'var(--color-dark-3)'
    )

    const label = graph.find('.storage-delivery-graph__label')
    expect(label.exists()).toBe(true)
    expect(label.attributes('fill')).toBe('#e8eaed')
  })
})

function makeTarget(overrides = {}) {
  return {
    id: 'tgt-s3',
    module: 's3',
    isEnabled: true,
    title: 'AWS S3',
    icon: '/x.svg',
    contentTypes: {
      activeTypes: ['images'],
      supportedTypes: ['images', 'documents', 'others', 'large'],
      largeThreshold: '5MB'
    },
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: true,
      streaming: false,
      directAccess: false
    },
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: true
    },
    props: {},
    config: {},
    actions: [],
    ...overrides
  }
}

async function mountTarget(target) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'
  useUserStore().permissions = ['manage:system']
  globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve([target]) })

  const router = buildTestRouter(['/_admin/:site/storage/:id'])
  await router.push(`/_admin/site-1/storage/${target.id}`)
  await router.isReady()
  const wrapper = mount(AdminStorage, { global: { plugins: [router, createTestI18n()] } })
  await flushPromises()
  return wrapper
}

const contentTypeCheckbox = (wrapper, type) =>
  wrapper.find(`button[role="checkbox"][aria-label="admin.storage.contentType${type}"]`)

describe('AdminStorage.vue - content types follow what the module supports', () => {
  it('hides the Pages checkbox for an object-store target', async () => {
    const wrapper = await mountTarget(makeTarget())

    expect(contentTypeCheckbox(wrapper, 'Images').exists()).toBe(true)
    expect(contentTypeCheckbox(wrapper, 'Pages').exists()).toBe(false)
  })

  it('shows every content type when the module supports them all', async () => {
    const wrapper = await mountTarget(
      makeTarget({
        module: 'sftp',
        contentTypes: {
          activeTypes: ['pages'],
          supportedTypes: ['pages', 'images', 'documents', 'others', 'large'],
          largeThreshold: '5MB'
        }
      })
    )

    for (const type of ['Pages', 'Images', 'Documents', 'Others', 'LargeFiles']) {
      expect(contentTypeCheckbox(wrapper, type).exists(), type).toBe(true)
    }
  })

  it('says a target with no live sync is not written to on every change', async () => {
    const live = await mountTarget(makeTarget())
    expect(live.text()).not.toContain('admin.storage.contentTypesNoLiveSyncHint')

    const pushless = await mountTarget(
      makeTarget({ sync: { ...makeTarget().sync, supportsContentSync: false } })
    )
    expect(pushless.text()).toContain('admin.storage.contentTypesNoLiveSyncHint')
  })
})
