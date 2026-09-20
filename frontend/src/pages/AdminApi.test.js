import { describe, expect, it } from 'vitest'

import AdminApi from './AdminApi.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

function mountPage() {
  return mountWithApp(AdminApi, {
    messages: {
      admin: {
        api: {
          keySite: 'Site: {site}',
          newKeySiteAllSites: 'All Sites'
        }
      }
    }
  }).wrapper
}

describe('AdminApi key list site caption', () => {
  it('names the site a key is pinned to', async () => {
    stubApi({
      'api-keys': [
        {
          id: 'key-1',
          name: 'Docs Key',
          keyShort: 'abcd',
          groups: [],
          scope: null,
          siteId: 'site-1',
          isRevoked: false,
          isInvalidated: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiration: '2099-01-01T00:00:00.000Z'
        }
      ],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [{ id: 'site-1', title: 'Docs' }],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const captions = wrapper.findAll('.w-settings-row__hint').map((c) => c.text())
    expect(captions.some((c) => c.includes('Docs'))).toBe(true)
  })

  it('shows "All Sites" for an instance-wide key (siteId: null)', async () => {
    stubApi({
      'api-keys': [
        {
          id: 'key-1',
          name: 'Global Key',
          keyShort: 'abcd',
          groups: [],
          scope: null,
          siteId: null,
          isRevoked: false,
          isInvalidated: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiration: '2099-01-01T00:00:00.000Z'
        }
      ],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [{ id: 'site-1', title: 'Docs' }],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.siteName({ siteId: null })).toBe('All Sites')
  })
})

describe('AdminApi personal token note', () => {
  function mountPageWithProfileNote() {
    return mountWithApp(AdminApi, {
      messages: {
        admin: {
          api: {
            personalTokenNote: 'Create a personal token instead, from {link}.',
            personalTokenNoteLink: 'Profile > API Access'
          }
        }
      }
    }).wrapper
  }

  it('opens Profile on its API-keys section when no admin keys exist yet', async () => {
    stubApi({
      'api-keys': [],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const { wrapper, siteStore } = mountWithApp(AdminApi, {
      messages: {
        admin: {
          api: {
            personalTokenNote: 'Create a personal token instead, from {link}.',
            personalTokenNoteLink: 'Profile > API Access'
          }
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Profile > API Access')
    const link = wrapper.findAll('button').find((b) => b.text() === 'Profile > API Access')
    expect(link.exists()).toBe(true)

    await link.trigger('click')

    expect(siteStore.overlay).toBe('Profile')
    expect(siteStore.overlayOpts).toEqual({ section: 'api' })
  })

  it('still shows the note when admin keys already exist', async () => {
    stubApi({
      'api-keys': [
        {
          id: 'key-1',
          name: 'Docs Key',
          keyShort: 'abcd',
          groups: [],
          scope: null,
          siteId: null,
          isRevoked: false,
          isInvalidated: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiration: '2099-01-01T00:00:00.000Z'
        }
      ],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPageWithProfileNote()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Profile > API Access')
  })

  it('styles the note as a warning, not a neutral info note', async () => {
    stubApi({
      'api-keys': [],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPageWithProfileNote()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const cards = wrapper.findAll('.w-card')
    const noteCard = cards.find((c) => c.text().includes('Profile > API Access'))

    expect(noteCard.classes()).toContain('bg-warning-fill')
    expect(noteCard.classes()).toContain('text-ink')
    expect(noteCard.classes()).not.toContain('bg-dark-5')
    expect(noteCard.classes()).not.toContain('bg-grey-3')
    expect(noteCard.find('[data-icon="tabler:alert-triangle"]').exists()).toBe(true)
    expect(noteCard.find('[data-icon="tabler:info-circle"]').exists()).toBe(false)
  })
})

describe('AdminApi header icon (OpenProject #2831)', () => {
  it("matches Profile's tabler:api icon", async () => {
    stubApi({
      'api-keys': [],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.admin-icon[data-icon="tabler:api"]').exists()).toBe(true)
    expect(wrapper.find('.admin-icon[data-icon="tabler:plug-connected"]').exists()).toBe(false)
  })
})

// -> `/dev/api` names a concept this fork invented, so no docs site can describe it. The Swagger UI
//    button (`href="/_api"`) is a real backend-served link, not a `docsBase` deep path, and stays.
describe('AdminApi help link', () => {
  it('has no help/docs button', async () => {
    stubApi({
      'api-keys': [],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.html()).not.toContain('/dev/api')
  })
})
