import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminComments from './AdminComments.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Task 621 (Feature 394, "Admin comments management UI rebuild"): the provider selection &
 * configuration panel. Rewrites `AdminComments.vue` from its pre-3.x Vuetify/pug/Apollo body (see
 * Task 614's regression test, `AdminLayout.test.js`, for that history) into a `<script setup>` +
 * `<w-page>` component modeled on `AdminStorage.vue`'s left-list/right-detail layout, simplified to
 * single-active-selection semantics.
 */

const messages = {
  en: {
    admin: {
      comments: {
        title: 'Comments',
        subtitle: 'Add discussions to your wiki pages',
        provider: 'Provider',
        providerConfig: 'Provider Configuration',
        providerNoConfig: 'This provider has no configuration options you can modify.',
        noProviders: 'No comment provider modules are installed.',
        loadFailed: 'Failed to load comment providers.',
        saveFailed: 'Failed to save the comment provider configuration.',
        saveSuccess: 'Comment provider configuration saved successfully.',
        enabledNoProviderHint: 'Comments are enabled in General, but no provider is active yet.',
        goToGeneral: 'Go to General'
      }
    },
    common: { actions: { apply: 'Apply', viewDocs: 'View docs' } }
  }
}

const PROVIDERS = [
  {
    id: 'p1',
    module: 'disqus',
    isEnabled: true,
    title: 'Disqus',
    description: 'A hosted comments service.',
    icon: '',
    vendor: 'Disqus Inc.',
    website: 'https://disqus.com',
    isAvailable: true,
    props: {
      shortname: {
        type: 'string',
        title: 'Shortname',
        hint: 'Your Disqus shortname',
        default: '',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 1,
        if: []
      }
    },
    config: { shortname: 'my-site' }
  },
  {
    id: 'p2',
    module: 'default',
    isEnabled: false,
    title: 'Default',
    description: 'Built-in comments, no configuration required.',
    icon: '',
    vendor: 'Wiki.js',
    website: '',
    isAvailable: true,
    props: {},
    config: {}
  }
]

function mountPage({ providers = PROVIDERS, putImpl, sites } = {}) {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site1'
  adminStore.sites = sites ?? [{ id: 'site1', features: { comments: true } }]

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'sites/site1/comments/providers') {
      return { json: () => Promise.resolve(providers) }
    }
    return { json: () => Promise.resolve(undefined) }
  })
  if (putImpl) {
    API_CLIENT.put.mockImplementation(putImpl)
  }

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/_admin/:siteid/comments', component: { template: '<div />' } },
      { path: '/_admin/:siteid/general', component: { template: '<div />' } }
    ]
  })
  router.push('/_admin/site1/comments')

  const i18n = createI18n({ legacy: false, locale: 'en', messages })

  const wrapper = mount(AdminComments, {
    global: { plugins: [router, i18n] }
  })

  return { wrapper, adminStore, router }
}

describe('AdminComments', () => {
  it('mounts and renders its header without throwing', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('Comments')
    expect(wrapper.text()).toContain('Add discussions to your wiki pages')
  })

  it('fetches providers for the current site and lists them', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site1/comments/providers')
    expect(wrapper.text()).toContain('Disqus')
    expect(wrapper.text()).toContain('Default')
  })

  it('defaults the selection to the currently enabled provider', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    // -> The enabled provider's own config field should be rendered on the right
    expect(wrapper.text()).toContain('Shortname')
  })

  it('switches the detail panel when a different provider is picked, radio-style', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    const items = wrapper.findAll('.w-item')
    const defaultItem = items.find((i) => i.text().includes('Default'))
    await defaultItem.trigger('click')
    await flushPromises()

    // -> `default` has no config props, so the "no config" message should now show instead
    expect(wrapper.text()).toContain('This provider has no configuration options you can modify.')
  })

  it('shows a hint pointing at General when comments are enabled but no provider is active', async () => {
    const noneEnabled = PROVIDERS.map((p) => ({ ...p, isEnabled: false }))
    const { wrapper } = mountPage({ providers: noneEnabled })
    await flushPromises()

    expect(wrapper.text()).toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('does not show the hint when comments are disabled for the site', async () => {
    const noneEnabled = PROVIDERS.map((p) => ({ ...p, isEnabled: false }))
    const { wrapper } = mountPage({
      providers: noneEnabled,
      sites: [{ id: 'site1', features: { comments: false } }]
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('does not show the hint when a provider is already active', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).not.toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('saves the selected provider and its config via PUT, then reloads', async () => {
    const put = vi.fn(() => ({ json: () => Promise.resolve(PROVIDERS[0]) }))
    const { wrapper } = mountPage({ putImpl: put })
    await flushPromises()

    const applyBtn = wrapper.findAll('button').find((b) => b.text() === 'Apply')
    await applyBtn.trigger('click')
    await flushPromises()

    expect(put).toHaveBeenCalledWith(
      'sites/site1/comments/providers',
      expect.objectContaining({
        json: { module: 'disqus', config: { shortname: 'my-site' } }
      })
    )
    // -> save() reloads on success
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site1/comments/providers')
  })

  it('renders a message when no provider modules are installed', async () => {
    const { wrapper } = mountPage({ providers: [] })
    await flushPromises()

    expect(wrapper.text()).toContain('No comment provider modules are installed.')
  })
})
