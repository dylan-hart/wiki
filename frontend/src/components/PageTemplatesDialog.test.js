import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageTemplatesDialog from './PageTemplatesDialog.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

const TEMPLATES = [
  {
    id: 'tpl-1',
    name: 'Meeting notes',
    description: 'Weekly sync',
    editor: 'markdown',
    locale: null
  },
  { id: 'tpl-2', name: 'Runbook', description: '', editor: 'wysiwyg', locale: 'fr' }
]

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  openDialogs.splice(0, openDialogs.length)
  notifyQueue.splice(0, notifyQueue.length)
})

async function mountDialog(templates = TEMPLATES) {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'
  API_CLIENT.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue(structuredClone(templates))
  })

  currentWrapper = mount(PageTemplatesDialog, {
    global: { plugins: [createTestI18n()] }
  })
  await flushPromises()
  return currentWrapper
}

describe('PageTemplatesDialog', () => {
  it('lists every template the site holds, asking without a basePath', async () => {
    const wrapper = await mountDialog()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/page-templates')
    expect(wrapper.vm.state.templates.map((tpl) => tpl.name)).toEqual(['Meeting notes', 'Runbook'])
    expect(document.body.textContent).toContain('Weekly sync')
  })

  it('shows an empty state when there are no templates', async () => {
    await mountDialog([])

    expect(document.body.textContent).toContain('pageTemplateManage.empty')
  })

  it('offers a retry when the list fails to load', async () => {
    setActivePinia(createPinia())
    useSiteStore().id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockRejectedValue(new Error('boom')) })
    currentWrapper = mount(PageTemplatesDialog, { global: { plugins: [createTestI18n()] } })
    await flushPromises()

    expect(currentWrapper.vm.state.loadFailed).toBe(true)
  })

  it('renames through PUT with only the name and description', async () => {
    const wrapper = await mountDialog()
    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ id: 'tpl-1', name: 'Standup', description: 'Daily' })
    })

    wrapper.vm.startEdit(wrapper.vm.state.templates[0])
    wrapper.vm.state.draftName = '  Standup '
    wrapper.vm.state.draftDescription = ' Daily '
    await wrapper.vm.commitEdit(wrapper.vm.state.templates[0])
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/page-templates/tpl-1', {
      json: { name: 'Standup', description: 'Daily' }
    })
    expect(wrapper.vm.state.templates[0]).toMatchObject({ name: 'Standup', description: 'Daily' })
    expect(wrapper.vm.state.editingId).toBeNull()
  })

  it('does not send a blank name', async () => {
    const wrapper = await mountDialog()

    wrapper.vm.startEdit(wrapper.vm.state.templates[0])
    wrapper.vm.state.draftName = '   '
    await wrapper.vm.commitEdit(wrapper.vm.state.templates[0])

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('keeps the row open and reports the server message when a rename collides', async () => {
    const wrapper = await mountDialog()
    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockRejectedValue({
        message: 'Request failed with status code 409',
        data: { message: 'A template with this name already exists for this locale.' }
      })
    })

    wrapper.vm.startEdit(wrapper.vm.state.templates[0])
    wrapper.vm.state.draftName = 'Runbook'
    await wrapper.vm.commitEdit(wrapper.vm.state.templates[0])
    await flushPromises()

    expect(wrapper.vm.state.editingId).toBe('tpl-1')
    expect(wrapper.vm.state.templates[0].name).toBe('Meeting notes')
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'A template with this name already exists for this locale.'
    })
  })

  it('deletes only after a destructive confirmation, then drops the row', async () => {
    const wrapper = await mountDialog()
    API_CLIENT.delete.mockReturnValueOnce({})

    wrapper.vm.askDelete(wrapper.vm.state.templates[1])

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ destructive: true, persistent: true })
    expect(API_CLIENT.delete).not.toHaveBeenCalled()

    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/page-templates/tpl-2')
    expect(wrapper.vm.state.templates.map((tpl) => tpl.id)).toEqual(['tpl-1'])
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    const wrapper = await mountDialog()

    wrapper.vm.askDelete(wrapper.vm.state.templates[0])
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    expect(wrapper.vm.state.templates).toHaveLength(2)
  })
})
