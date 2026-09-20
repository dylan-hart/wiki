import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import CheckUpdateDialog from './CheckUpdateDialog.vue'

import { mountWithApp } from '../../test/mount.js'

afterEach(() => {
  document.body.innerHTML = ''
})

async function mountWithResponse(payload) {
  globalThis.API_CLIENT.post.mockReturnValue({ json: () => Promise.resolve(payload) })
  const { wrapper } = mountWithApp(CheckUpdateDialog, { stubs: {}, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const found = (test) => document.body.querySelector(`[data-test="${test}"]`)

describe('CheckUpdateDialog verdict', () => {
  it('posts to system/checkForUpdate', async () => {
    await mountWithResponse({
      current: '3.0.0',
      latest: '3.0.0',
      latestDate: '2026-08-01T00:00:00Z'
    })

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('system/checkForUpdate')
  })

  it('reports up to date when current equals latest', async () => {
    const wrapper = await mountWithResponse({
      current: '3.0.0',
      latest: '3.0.0',
      latestDate: '2026-08-01T00:00:00Z'
    })

    expect(wrapper.vm.status).toBe('latest')
    expect(found('update-latest')).not.toBeNull()
    expect(found('update-available')).toBeNull()
  })

  it('reports an update when latest is a newer prerelease build', async () => {
    const wrapper = await mountWithResponse({
      current: '3.0.0-alpha.5',
      latest: '3.0.0-alpha.12',
      latestDate: '2026-08-01T00:00:00Z'
    })

    expect(wrapper.vm.status).toBe('outdated')
    expect(found('update-available')).not.toBeNull()
    expect(found('update-latest')).toBeNull()
  })

  it('reports an update for a newer stable release', async () => {
    const wrapper = await mountWithResponse({
      current: '3.0.0',
      latest: '3.1.0',
      latestDate: '2026-08-01T00:00:00Z'
    })

    expect(wrapper.vm.status).toBe('outdated')
  })

  it('shows an explicit offline message instead of blank latest fields', async () => {
    const wrapper = await mountWithResponse({ current: '3.0.0', offline: true })

    expect(wrapper.vm.status).toBe('offline')
    expect(found('update-offline')).not.toBeNull()
    expect(found('update-latest')).toBeNull()
    expect(found('update-available')).toBeNull()
    expect(document.body.textContent).not.toContain('Latest:')
  })

  it('does not claim either verdict when no release information came back', async () => {
    const wrapper = await mountWithResponse({ current: '3.0.0' })

    expect(wrapper.vm.status).toBe('unknown')
    expect(found('update-unknown')).not.toBeNull()
    expect(found('update-latest')).toBeNull()
  })

  it('has no upgrade action', async () => {
    const wrapper = await mountWithResponse({ current: '3.0.0', latest: '3.1.0' })

    expect(wrapper.vm.state).not.toHaveProperty('canUpgrade')
    expect(document.body.textContent).not.toContain('admin.system.upgrade')
  })
})
