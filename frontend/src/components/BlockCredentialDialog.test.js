import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import BlockCredentialDialog from './BlockCredentialDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

async function mountDialog(props) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const i18n = createTestI18n()
  const wrapper = mount(BlockCredentialDialog, {
    props,
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return { wrapper, adminStore }
}

/** Types into the origin entry field and fires its `keyup:enter` custom emit, same as a real Enter key. */
async function addOrigin(wrapper, origin) {
  const originInput = wrapper.findAll('input').at(-1)
  await originInput.setValue(origin)
  await originInput.trigger('keyup.enter')
}

describe('BlockCredentialDialog (mode: create)', () => {
  it('disables submit until name, secret and at least one origin are filled in', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const submit = () =>
      wrapper.findAll('button').find((btn) => btn.text() === 'admin.blocks.credentialAdd')

    expect(submit().attributes('disabled')).toBeDefined()

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    expect(submit().attributes('disabled')).toBeDefined()

    await inputs[1].setValue('sekret-token')
    expect(submit().attributes('disabled')).toBeDefined()

    await addOrigin(wrapper, 'https://api.example.com')
    expect(submit().attributes('disabled')).toBeUndefined()
  })

  it('adds an origin as a chip on Enter and clears the input, trimmed and deduplicated', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addOrigin(wrapper, '  https://api.example.com  ')
    expect(wrapper.text()).toContain('https://api.example.com')
    await addOrigin(wrapper, 'https://api.example.com')
    expect(wrapper.findAll('.w-chip, [class*=chip]').length).toBeLessThanOrEqual(1)
  })

  it('normalizes the scheme and host to lowercase but preserves path casing', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addOrigin(wrapper, 'HTTPS://API.example.com/V1')
    expect(wrapper.vm.state.allowedOrigins).toEqual(['https://api.example.com/V1'])
  })

  it('rejects a malformed origin, shows an inline error, and does not add a chip (OpenProject #2195/#2198)', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addOrigin(wrapper, 'api.example.com')
    expect(wrapper.vm.state.allowedOrigins).toEqual([])
    expect(wrapper.text()).toContain('admin.blocks.credentialAllowedDomainsInvalid')

    // Fixing the value and retrying succeeds, and the error clears.
    await addOrigin(wrapper, 'https://api.example.com')
    expect(wrapper.vm.state.allowedOrigins).toEqual(['https://api.example.com'])
    expect(wrapper.text()).not.toContain('admin.blocks.credentialAllowedDomainsInvalid')
  })

  it('removes an origin chip when its remove control is clicked', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addOrigin(wrapper, 'https://api.example.com')
    expect(wrapper.vm.state.allowedOrigins).toEqual(['https://api.example.com'])
    await wrapper.find('[aria-label], .w-chip__remove, button').exists()
    wrapper.vm.removeOrigin('https://api.example.com')
    expect(wrapper.vm.state.allowedOrigins).toEqual([])
  })

  it('creates the credential with the entered origins, secret never in the emitted payload', async () => {
    const { wrapper, adminStore } = await mountDialog({ mode: 'create' })
    const created = {
      id: 'cred-1',
      siteId: 'site-1',
      name: 'Weather API',
      allowedOrigins: ['https://api.example.com']
    }
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(created) })

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')
    await addOrigin(wrapper, 'https://api.example.com')

    const submit = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
    await submit.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials`,
      {
        json: {
          name: 'Weather API',
          secret: 'sekret-token',
          allowedOrigins: ['https://api.example.com']
        }
      }
    )
    expect(wrapper.emitted('ok')).toEqual([[created]])
  })

  it('shows an error and does not emit ok when creation fails', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const err = Object.assign(new Error('Request failed'), {
      data: { message: 'name is required.' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockRejectedValue(err) })
    notifyQueue.length = 0

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')
    await addOrigin(wrapper, 'https://api.example.com')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
      .trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'name is required.'
    })
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})

describe('BlockCredentialDialog (mode: rotate)', () => {
  it('has no name field, no origin field, only a secret field, and posts to the rotate route', async () => {
    const { wrapper, adminStore } = await mountDialog({
      mode: 'rotate',
      credential: { id: 'cred-1', name: 'Weather API', allowedOrigins: ['https://api.example.com'] }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })

    expect(wrapper.findAll('input')).toHaveLength(1)

    await wrapper.find('input').setValue('new-secret')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialRotate')
      .trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials/cred-1/rotate`,
      { json: { secret: 'new-secret' } }
    )
    expect(wrapper.emitted('ok')).toEqual([[undefined]])
  })

  it('reveals and hides the secret via its reveal toggle (OpenProject #1098)', async () => {
    const { wrapper } = await mountDialog({
      mode: 'rotate',
      credential: { id: 'cred-1', name: 'Weather API', allowedOrigins: ['https://api.example.com'] }
    })
    const secretInput = wrapper.find('input')
    expect(secretInput.attributes('type')).toBe('password')

    const revealBtn = wrapper.find('[aria-label="admin.blocks.credentialSecretReveal"]')
    expect(revealBtn.exists()).toBe(true)

    await revealBtn.trigger('click')
    expect(secretInput.attributes('type')).toBe('text')
    expect(wrapper.find('[aria-label="admin.blocks.credentialSecretHide"]').exists()).toBe(true)
  })
})

describe('BlockCredentialDialog (mode: domains)', () => {
  it("starts pre-filled with the credential's existing origins and posts the replaced list", async () => {
    const { wrapper, adminStore } = await mountDialog({
      mode: 'domains',
      credential: { id: 'cred-1', name: 'Weather API', allowedOrigins: ['https://old.example.com'] }
    })
    expect(wrapper.text()).toContain('https://old.example.com')

    wrapper.vm.removeOrigin('https://old.example.com')
    await addOrigin(wrapper, 'https://new.example.com')

    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialDomains')
      .trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials/cred-1/allowed-origins`,
      { json: { allowedOrigins: ['https://new.example.com'] } }
    )
    expect(wrapper.emitted('ok')).toEqual([[undefined]])
  })

  it('allows submitting an empty origin list, deliberately disabling the credential', async () => {
    const { wrapper } = await mountDialog({
      mode: 'domains',
      credential: { id: 'cred-1', name: 'Weather API', allowedOrigins: ['https://old.example.com'] }
    })
    const submit = () =>
      wrapper.findAll('button').find((btn) => btn.text() === 'admin.blocks.credentialDomains')
    wrapper.vm.removeOrigin('https://old.example.com')
    await wrapper.vm.$nextTick()
    expect(submit().attributes('disabled')).toBeUndefined()
  })
})
