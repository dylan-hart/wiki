import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminAi from './AdminAi.vue'
import { mountWithApp } from '../../test/mount.js'

const MASK = '********'

function prop(overrides) {
  return {
    default: '',
    type: 'string',
    hint: '',
    enum: false,
    enumDisplay: 'select',
    multiline: false,
    sensitive: false,
    readOnly: false,
    required: false,
    pattern: '',
    icon: 'rename',
    if: [],
    ...overrides
  }
}

function provider(overrides = {}) {
  return {
    key: 'anthropic',
    title: 'Anthropic',
    description: 'Claude models.',
    vendor: 'Anthropic',
    website: 'https://www.anthropic.com',
    props: {
      apiKey: prop({ title: 'API Key', sensitive: true, required: true, order: 1 }),
      model: prop({ title: 'Model', default: 'claude-default', order: 2 })
    },
    hasImplementation: true,
    isSelected: false,
    config: { apiKey: '', model: 'claude-default' },
    ...overrides
  }
}

function providers({ selected = '' } = {}) {
  return [
    provider({
      isSelected: selected === 'anthropic',
      config: { apiKey: selected === 'anthropic' ? MASK : '', model: 'claude-default' }
    }),
    provider({
      key: 'openai',
      title: 'OpenAI',
      description: 'GPT models.',
      website: 'https://openai.com',
      isSelected: selected === 'openai',
      config: { apiKey: '', model: 'gpt-default' }
    })
  ]
}

async function mountLoaded(list) {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(list) })
  const { wrapper } = mountWithApp(AdminAi, {
    stores: { admin: { currentSiteId: 'site-1' } }
  })
  await flushPromises()
  return wrapper
}

function applyButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().includes('common.actions.apply'))
}

async function pick(wrapper, label) {
  await wrapper.find('[role="combobox"][aria-label="admin.ai.provider"]').trigger('click')
  const option = wrapper.findAll('[role="option"]').find((row) => row.text().trim() === label)
  expect(option).toBeDefined()
  await option.trigger('click')
  await flushPromises()
}

describe('AdminAi', () => {
  it('loads the providers for the administered site', async () => {
    await mountLoaded(providers())
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/ai/providers')
  })

  it('shows no provider form while no provider is selected', async () => {
    const wrapper = await mountLoaded(providers())
    expect(wrapper.find('input[aria-label="API Key"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('admin.ai.disabledNotice')
  })

  it('shows the selected provider config, with the stored key still masked', async () => {
    const wrapper = await mountLoaded(providers({ selected: 'anthropic' }))
    const keyInput = wrapper.find('input[aria-label="API Key"]')
    expect(keyInput.exists()).toBe(true)
    expect(keyInput.element.value).toBe(MASK)
    expect(wrapper.find('input[aria-label="Model"]').element.value).toBe('claude-default')
  })

  it('saves the selected provider and its config, echoing the mask back untouched', async () => {
    const wrapper = await mountLoaded(providers({ selected: 'anthropic' }))
    await wrapper.find('input[aria-label="Model"]').setValue('claude-bigger')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(providers({ selected: 'anthropic' }))
    })
    await applyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [url, options] = API_CLIENT.put.mock.calls[0]
    expect(url).toBe('sites/site-1/ai')
    expect(options.json).toEqual({
      provider: 'anthropic',
      config: { apiKey: MASK, model: 'claude-bigger' }
    })
  })

  it('switches to another provider from the dropdown and saves its config', async () => {
    const wrapper = await mountLoaded(providers())
    await pick(wrapper, 'OpenAI')
    await wrapper.find('input[aria-label="API Key"]').setValue('sk-new')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(providers({ selected: 'openai' }))
    })
    await applyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put.mock.calls[0][1].json).toEqual({
      provider: 'openai',
      config: { apiKey: 'sk-new', model: 'gpt-default' }
    })
  })

  it('turns AI off by saving an empty provider', async () => {
    const wrapper = await mountLoaded(providers({ selected: 'anthropic' }))
    await pick(wrapper, 'admin.ai.providerNone')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(providers()) })
    await applyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put.mock.calls[0]).toEqual(['sites/site-1/ai', { json: { provider: '' } }])
  })

  it('reloads after a save, so the fresh masked listing replaces what was typed', async () => {
    const wrapper = await mountLoaded(providers())
    await pick(wrapper, 'Anthropic')
    await wrapper.find('input[aria-label="API Key"]').setValue('sk-typed')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(providers({ selected: 'anthropic' }))
    })
    await applyButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('input[aria-label="API Key"]').element.value).toBe(MASK)
  })

  it('offers a provider with no implementation only as a disabled option', async () => {
    const list = providers()
    list[1].hasImplementation = false
    const wrapper = await mountLoaded(list)
    await wrapper.find('[role="combobox"][aria-label="admin.ai.provider"]').trigger('click')
    const row = wrapper
      .findAll('[role="option"]')
      .find((el) => el.text().includes('admin.ai.providerUnavailable'))
    expect(row).toBeDefined()
    expect(row.attributes('aria-disabled')).toBe('true')
  })
})
