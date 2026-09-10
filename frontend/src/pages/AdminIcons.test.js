import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminIcons from './AdminIcons.vue'
import { queue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * OpenProject #2947: mirrors `AdminLocale.vue`'s "Offline Sideload" card, gated by `manage:system`,
 * for `POST /_api/icons/sideload` (`backend/api/icons.ts`, OpenProject #2946). The response shape
 * is icons-specific -- `{ loaded: { prefix, iconCount }[], skipped: { prefix, error }[] }` -- which
 * differs from the locale route's `{ loaded: string[], skipped: { code, error }[] }`, so the
 * success/failure captions here map over `.prefix`/`.error` rather than joining plain codes.
 */

const SETS = [{ prefix: 'mdi', name: 'Material Design Icons', iconCount: 12, info: {} }]

async function mountPage({ permissions = ['manage:sites'] } = {}) {
  stubApi(
    new Map([
      ['icons/sets', SETS],
      ['icons/cache', { iconCount: 0, diskCount: 0, diskSize: 0, memoryCount: 0 }]
    ])
  )

  return mountWithApp(AdminIcons, {
    messages: {
      admin: {
        icons: {
          sideload: 'Sideload Icon Sets',
          sideloadHelp: 'sideload help text',
          sideloadSuccess: '{count} icon set(s) loaded successfully.',
          sideloadNone: 'No icon sets were found to sideload.',
          sideloadFailed: 'Failed to sideload icon sets.'
        }
      }
    },
    stores: { user: { permissions } }
  }).wrapper
}

describe('AdminIcons: offline sideload control', () => {
  function sideloadButton(wrapper) {
    return wrapper.findAll('button').find((b) => b.text().includes('Sideload Icon Sets'))
  }

  beforeEach(() => {
    queue.splice(0, queue.length)
  })

  it('is hidden for an admin without manage:system', async () => {
    const wrapper = await mountPage({ permissions: ['manage:sites'] })
    await flushPromises()

    expect(sideloadButton(wrapper)).toBeUndefined()
  })

  it('renders the sideload control and help text for a manage:system admin', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    expect(sideloadButton(wrapper)).toBeDefined()
    expect(wrapper.text()).toContain('sideload help text')
  })

  it('posts to icons/sideload and renders a success state, then refreshes the icon set list', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()
    API_CLIENT.get.mockClear()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ loaded: [{ prefix: 'tabler', iconCount: 5000 }], skipped: [] })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('icons/sideload')
    expect(queue.at(-1)).toMatchObject({
      type: 'positive',
      message: '1 icon set(s) loaded successfully.',
      caption: 'tabler'
    })
    // -> A newly-loaded set should show up without a manual page refresh
    expect(API_CLIENT.get).toHaveBeenCalledWith('icons/sets')
  })

  it('reports a partial run: a skipped file alongside sets that did load', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          loaded: [{ prefix: 'tabler', iconCount: 5000 }],
          skipped: [{ prefix: 'bogus', error: 'invalid collection JSON' }]
        })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue).toContainEqual(
      expect.objectContaining({
        type: 'positive',
        message: '1 icon set(s) loaded successfully.'
      })
    )
    expect(queue).toContainEqual(
      expect.objectContaining({
        type: 'negative',
        message: 'Failed to sideload icon sets.',
        caption: 'bogus: invalid collection JSON'
      })
    )
  })

  it('reports nothing found when neither loaded nor skipped came back', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ loaded: [], skipped: [] })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue.at(-1)).toMatchObject({
      type: 'info',
      message: 'No icon sets were found to sideload.'
    })
  })

  it('shows a failure toast when the request itself fails', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network')
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to sideload icon sets.'
    })
  })
})
