import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageTemplateSaveDialog from './PageTemplateSaveDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  notifyQueue.splice(0, notifyQueue.length)
})

async function mountDialog(props = {}) {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'

  currentWrapper = mount(PageTemplateSaveDialog, {
    props: {
      content: '# Agenda\n\n- item\n',
      editor: 'markdown',
      locale: 'en',
      defaultName: 'Weekly sync',
      defaultDescription: 'Notes skeleton',
      ...props
    },
    global: { plugins: [createTestI18n()] }
  })
  await flushPromises()
  return currentWrapper
}

describe('PageTemplateSaveDialog', () => {
  it("POSTs the page's content and editor with the entered name to sites/:siteId/page-templates", async () => {
    const wrapper = await mountDialog()
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ id: 'tpl-1' }) })
    wrapper.vm.state.name = '  Meeting notes  '

    await wrapper.vm.save()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/page-templates', {
      json: {
        name: 'Meeting notes',
        description: 'Notes skeleton',
        editor: 'markdown',
        locale: null,
        content: '# Agenda\n\n- item\n'
      }
    })
    expect(wrapper.emitted('ok')[0][0]).toEqual({ id: 'tpl-1' })
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'positive' })
  })

  it("binds the template to the page's locale when the reader unticks all languages", async () => {
    const wrapper = await mountDialog({ locale: 'fr', editor: 'wysiwyg' })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({}) })
    wrapper.vm.state.allLocales = false

    await wrapper.vm.save()
    await flushPromises()

    expect(API_CLIENT.post.mock.calls[0][1].json).toMatchObject({
      editor: 'wysiwyg',
      locale: 'fr'
    })
  })

  it('refuses a blank name without calling the API', async () => {
    const wrapper = await mountDialog({ defaultName: '' })
    wrapper.vm.state.name = '   '

    await wrapper.vm.save()
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it("keeps the dialog open and shows the server's message on a duplicate name", async () => {
    const wrapper = await mountDialog()
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockRejectedValue({
        message: 'Request failed with status code 409',
        data: { message: 'A template with this name already exists for this locale.' }
      })
    })

    await wrapper.vm.save()
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeUndefined()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'A template with this name already exists for this locale.'
    })
  })
})
