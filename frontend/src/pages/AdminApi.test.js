import { describe, expect, it } from 'vitest'

import AdminApi from './AdminApi.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * Covers the site caption line added to each key row (task 622): a key pinned to a site names that
 * site, and an unpinned key (`siteId: null`, instance-wide) reads "All Sites" rather than a blank
 * or broken value -- the same treatment `newKeyFullAccess` already gives a `null` scope just above
 * it in the same list item.
 */
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

    const captions = wrapper.findAll('.w-item-label--caption').map((c) => c.text())
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

/**
 * Task 2410: coworkers testing the demo went to Admin > API Access expecting to mint an
 * MCP-usable token there and got confused -- a personal token (the credential type MCP actually
 * attributes page authorship to) is only created from Profile > API Access. Covers the note
 * pointing there, and that it links to the real route -- shown whether or not admin-issued keys
 * already exist, since the confusion applies either way.
 */
describe('AdminApi personal token note', () => {
  function mountPageWithProfileRoute() {
    return mountWithApp(AdminApi, {
      routes: ['/_profile/api'],
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

  it('links to Profile > API Access when no admin keys exist yet', async () => {
    stubApi({
      'api-keys': [],
      'system/api': { isEnabled: true },
      groups: [],
      sites: [],
      'system/certificates': { generatedAt: null }
    })

    const wrapper = mountPageWithProfileRoute()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Profile > API Access')
    const link = wrapper.find('a[href="/_profile/api"]')
    expect(link.exists()).toBe(true)
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

    const wrapper = mountPageWithProfileRoute()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const link = wrapper.find('a[href="/_profile/api"]')
    expect(link.exists()).toBe(true)
  })
})

// -> OpenProject #1929: `/dev/api` names a concept this fork invented (there is no such upstream
//    Wiki.js docs section), so no docs site can describe it -- the help button was deleted rather
//    than left pointing at a page that does not exist. The Swagger UI button (`href="/_api"`) is
//    unrelated -- a real backend-served link, not a `docsBase` deep path -- and stays.
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
