import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { TimeoutError } from 'ky'

import AdminExtensions from './AdminExtensions.vue'
import { isActive as loadingIsActive } from '@/composables/loading'
import { dismiss as dismissNotification, queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

/** `siteStore.docsBase` is server-provided with no frontend default, so it is set explicitly here
 *  rather than leaving these tests to exercise `''`. */
const TEST_DOCS_BASE = 'https://docs.example.test'

const messages = {
  'admin.extensions.needsRestart':
    'This extension failed to load and needs the server restarted before it can be used.',
  'admin.extensions.incompatible': 'not compatible',
  'admin.extensions.installed': 'Installed',
  'admin.extensions.install': 'Install',
  'admin.extensions.reinstall': 'Reinstall',
  'admin.extensions.instructions': 'Instructions',
  'admin.extensions.instructionsHint': 'Must be installed manually',
  'admin.extensions.title': 'Extensions',
  'admin.extensions.subtitle': 'Install extensions for extra functionality',
  'admin.extensions.installing': 'Installing extension...',
  'admin.extensions.installingHint': 'This may take a while depending on your server.',
  'admin.extensions.installElapsed': 'Elapsed: {time}',
  'admin.extensions.installFailed': 'Failed to install extension.',
  'admin.extensions.installTimedOut': 'Still installing — the request timed out waiting for it.',
  'admin.extensions.installTimedOutHint':
    'This does not necessarily mean it failed. Refresh this page in a few minutes to check before trying again.',
  'admin.extensions.installSuccess': 'Extension installed successfully.',
  'common.actions.viewDocs': 'View docs',
  'common.actions.refresh': 'Refresh'
}

async function mountWithExtensions(extensions) {
  globalThis.API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(extensions) })

  const { wrapper } = mountWithApp(AdminExtensions, {
    messages,
    stores: { site: { docsBase: TEST_DOCS_BASE } },
    stubs: {
      // -> `WTooltip` teleports its panel to <body> and only renders it once a hover timer fires, so
      //    stubbing it is what makes what this page passes a tooltip assertable at all.
      WTooltip: { template: '<div class="stub-tooltip"><slot /></div>' }
    }
  })

  await flushPromises()
  return wrapper
}

/** The row's install/reinstall button -- distinct from the header's "Refresh" `<button>`, which is
 *  otherwise the first match for a bare `wrapper.find('button')`. */
function findInstallButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === 'Install')
}

describe('AdminExtensions needsRestart badge', () => {
  it('shows a persistent warning badge when needsRestart is true, unrelated to any install click', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'sharp',
        title: 'Sharp',
        description: 'Image processing',
        website: '',
        isInstalled: true,
        isInstallable: true,
        isCompatible: true,
        incompatibleReason: null,
        needsRestart: true
      }
    ])

    const badgeIcon = wrapper.find('[data-icon="tabler:alert-triangle"]')
    expect(badgeIcon.exists()).toBe(true)
    expect(wrapper.text()).toContain('needs the server restarted before it can be used')
  })

  it('shows no warning badge when needsRestart is false', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'sharp',
        title: 'Sharp',
        description: 'Image processing',
        website: '',
        isInstalled: true,
        isInstallable: true,
        isCompatible: true,
        incompatibleReason: null,
        needsRestart: false
      }
    ])

    expect(wrapper.find('[data-icon="tabler:alert-triangle"]').exists()).toBe(false)
  })
})

/** An anchor within the one `/system/extensions` page: the docs carry no page per extension key. */
describe('AdminExtensions per-row instructions link', () => {
  it('builds the Instructions button href from siteStore.docsBase, anchored to the extension key', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'git',
        title: 'Git',
        description: 'Distributed version control system',
        website: 'https://git-scm.com',
        isInstalled: false,
        isInstallable: false,
        isCompatible: true,
        incompatibleReason: null,
        needsRestart: false
      }
    ])

    const instructionsLink = wrapper.findAll('a').find((a) => a.text().includes('Instructions'))

    expect(instructionsLink.exists()).toBe(true)
    expect(instructionsLink.attributes('href')).toBe(`${TEST_DOCS_BASE}/system/extensions#git`)
  })
})

describe('AdminExtensions incompatible button tooltip', () => {
  it('names the required architecture/platform versus what this server reports', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'weird-ext',
        title: 'Weird Extension',
        description: 'Needs an architecture this server does not have',
        website: '',
        isInstalled: false,
        isInstallable: false,
        isCompatible: false,
        incompatibleReason: 'requires architecture arm64, but this server is running x64',
        needsRestart: false
      }
    ])

    expect(wrapper.text()).toContain('requires architecture arm64, but this server is running x64')
  })
})

const installableExt = {
  key: 'sharp',
  title: 'Sharp',
  description: 'Image processing',
  website: '',
  isInstalled: false,
  isInstallable: true,
  isCompatible: true,
  incompatibleReason: null,
  needsRestart: false
}

describe('AdminExtensions install progress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // -> The notify queue is a module singleton; clear it so one test's toast can't leak into the next.
    //    `dismiss()` splices the queue it walks, so index from the end rather than iterating forward.
    while (notifyQueue.length > 0) {
      dismissNotification(notifyQueue.at(-1).id)
    }
    vi.useRealTimers()
  })

  it('shows inline per-row status instead of the global loading overlay, and disables the button', async () => {
    const wrapper = await mountWithExtensions([installableExt])

    // -> Never resolves within the test, so the pending state is observable
    globalThis.API_CLIENT.post.mockReturnValueOnce({ json: () => new Promise(() => {}) })

    await findInstallButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Installing extension...')
    expect(wrapper.text()).toContain('This may take a while depending on your server.')
    // -> The install button itself is gone/replaced while the row is installing -- nothing to re-click
    expect(findInstallButton(wrapper)).toBeUndefined()
    // -> The global overlay (composables/loading.js) must never activate for this action
    expect(loadingIsActive.value).toBe(false)
  })

  it('shows a visible, ticking elapsed-time readout', async () => {
    const wrapper = await mountWithExtensions([installableExt])
    globalThis.API_CLIENT.post.mockReturnValueOnce({ json: () => new Promise(() => {}) })

    await findInstallButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Elapsed: 0:00')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()

    expect(wrapper.text()).toContain('Elapsed: 0:03')
  })

  it('gives a distinct, actionable message when the client timeout fires, not the generic install-failed caption', async () => {
    const wrapper = await mountWithExtensions([installableExt])
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.reject(
          new TimeoutError({ method: 'POST', url: '/_api/system/extensions/sharp/install' })
        )
    })

    await findInstallButton(wrapper).trigger('click')
    await flushPromises()

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].message).toBe('Still installing — the request timed out waiting for it.')
    expect(notifyQueue[0].message).not.toBe('Failed to install extension.')
    expect(notifyQueue[0].caption).toContain('Refresh this page in a few minutes')
  })

  it('still uses the generic install-failed caption for a real (non-timeout) failure', async () => {
    const wrapper = await mountWithExtensions([installableExt])
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(new Error('npm exited with code 1'))
    })

    await findInstallButton(wrapper).trigger('click')
    await flushPromises()

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].message).toBe('Failed to install extension.')
    expect(notifyQueue[0].caption).toBe('npm exited with code 1')
  })
})
