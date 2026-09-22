import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageNewMenu from './PageNewMenu.vue'
import PageTemplatePickerDialog from './PageTemplatePickerDialog.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

const TEMPLATE = {
  id: 'tpl-1',
  locale: null,
  name: 'Meeting Notes',
  description: 'Agenda, attendees and action items',
  editor: 'markdown',
  content: '# Agenda\n\n- [ ] Item one\n',
  createdBy: null,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z'
}

function mountMenu({ props = {}, locales = ['en'], pageLocale = 'en' } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false }
  siteStore.locales = { primary: 'en', active: locales }
  const editorStore = useEditorStore()
  editorStore.ensureConfigs = vi.fn()
  const pageStore = usePageStore()
  pageStore.router = { currentRoute: { value: { path: '/docs/guide' } }, push: vi.fn() }
  pageStore.$patch({ locale: pageLocale, path: 'docs/guide' })

  const wrapper = mount(PageNewMenu, {
    props,
    global: {
      plugins: [createTestI18n()],
      stubs: { WMenu: { template: '<div><slot /></div>' } }
    },
    attachTo: document.body
  })
  return { wrapper, pageStore }
}

async function openPicker(wrapper) {
  const row = wrapper
    .findAll('.w-item')
    .find((i) => i.text().includes('common.newPageMenu.fromTemplate'))
  expect(row).toBeTruthy()
  await row.trigger('click')
  return openDialogs.at(-1)
}

afterEach(() => {
  openDialogs.splice(0, openDialogs.length)
})

describe('PageNewMenu: From template', () => {
  it('opens the picker for the destination folder, as an async component', async () => {
    const { wrapper } = mountMenu({ props: { basePath: 'docs' } })
    await flushPromises()

    const opened = await openPicker(wrapper)

    expect(opened.component.__asyncLoader).toBeInstanceOf(Function)
    expect(opened.props).toEqual({ basePath: 'docs', locale: null })

    wrapper.unmount()
  })

  it('sends the site root as an empty basePath, never leaving it out', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const opened = await openPicker(wrapper)

    expect(opened.props.basePath).toBe('')

    wrapper.unmount()
  })

  it('carries the current locale to the picker on a multi-locale site', async () => {
    const { wrapper } = mountMenu({ locales: ['en', 'fr'], pageLocale: 'fr' })
    await flushPromises()

    const opened = await openPicker(wrapper)

    expect(opened.props.locale).toBe('fr')

    wrapper.unmount()
  })

  it('pre-fills the new page from the chosen template', async () => {
    const { wrapper, pageStore } = mountMenu({ props: { basePath: 'docs' } })
    await flushPromises()

    const opened = await openPicker(wrapper)
    closeDialog(opened.id, true, { template: TEMPLATE })
    await flushPromises()

    expect(pageStore.router.push).toHaveBeenCalledWith({
      path: '/_create/markdown',
      query: undefined
    })
    expect(pageStore.id).toBe(0)
    expect(pageStore.path).toBe('docs/new-page')
    expect(pageStore.editor).toBe('markdown')
    expect(pageStore.title).toBe('Meeting Notes')
    expect(pageStore.description).toBe('Agenda, attendees and action items')
    expect(pageStore.content).toBe('# Agenda\n\n- [ ] Item one\n')
    expect(pageStore.contentLoaded).toBe(true)
    expect(wrapper.emitted('newPage')).toHaveLength(1)

    wrapper.unmount()
  })

  it('starts the page in the template’s own editor and the current locale', async () => {
    const { wrapper, pageStore } = mountMenu({ locales: ['en', 'fr'], pageLocale: 'fr' })
    await flushPromises()

    const opened = await openPicker(wrapper)
    closeDialog(opened.id, true, {
      template: { ...TEMPLATE, editor: 'code', content: '<p>Hi</p>' }
    })
    await flushPromises()

    expect(pageStore.router.push).toHaveBeenCalledWith({
      path: '/_create/code',
      query: { locale: 'fr' }
    })
    expect(pageStore.editor).toBe('code')
    expect(pageStore.locale).toBe('fr')
    expect(pageStore.content).toBe('<p>Hi</p>')

    wrapper.unmount()
  })

  it('leaves the page store alone when the picker is cancelled', async () => {
    const { wrapper, pageStore } = mountMenu()
    await flushPromises()

    const opened = await openPicker(wrapper)
    closeDialog(opened.id, false)
    await flushPromises()

    expect(pageStore.router.push).not.toHaveBeenCalled()
    expect(pageStore.content).toBe('')
    expect(wrapper.emitted('newPage')).toBeUndefined()

    wrapper.unmount()
  })
})

describe('PageTemplatePickerDialog', () => {
  function mountDialog({ props = {}, editors = {}, experimental = false, response } = {}) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false, ...editors }
    useFlagsStore().experimental = experimental
    globalThis.API_CLIENT.get.mockImplementation(() => ({
      json: () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))
    }))
    return mount(PageTemplatePickerDialog, {
      props,
      global: { plugins: [createTestI18n()] },
      attachTo: document.body
    })
  }

  it('asks for the templates of the destination folder and locale', async () => {
    const wrapper = mountDialog({
      props: { basePath: 'docs', locale: 'fr' },
      response: [TEMPLATE]
    })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/page-templates', {
      searchParams: { basePath: 'docs', locale: 'fr' }
    })

    wrapper.unmount()
  })

  it('sends an empty basePath for the site root and no locale when none is given', async () => {
    const wrapper = mountDialog({ response: [] })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/page-templates', {
      searchParams: { basePath: '' }
    })

    wrapper.unmount()
  })

  it('hides templates whose editor is disabled for the site', async () => {
    const wrapper = mountDialog({
      editors: { code: false, asciidoc: true },
      response: [
        TEMPLATE,
        { ...TEMPLATE, id: 'tpl-2', name: 'Snippet', editor: 'code' },
        { ...TEMPLATE, id: 'tpl-3', name: 'Runbook', editor: 'asciidoc' }
      ]
    })
    await flushPromises()

    const body = document.body.textContent
    expect(body).toContain('Meeting Notes')
    expect(body).toContain('Runbook')
    expect(body).not.toContain('Snippet')

    wrapper.unmount()
  })

  it('offers a wysiwyg template only while the experimental flag is on', async () => {
    const wysiwygTemplate = { ...TEMPLATE, id: 'tpl-4', name: 'Visual Page', editor: 'wysiwyg' }

    const off = mountDialog({ editors: { wysiwyg: true }, response: [wysiwygTemplate] })
    await flushPromises()
    expect(document.body.textContent).not.toContain('Visual Page')
    off.unmount()

    const on = mountDialog({
      editors: { wysiwyg: true },
      experimental: true,
      response: [wysiwygTemplate]
    })
    await flushPromises()
    expect(document.body.textContent).toContain('Visual Page')
    on.unmount()
  })

  it('says so when nothing is offered', async () => {
    const wrapper = mountDialog({ response: [] })
    await flushPromises()

    expect(document.body.textContent).toContain('pages.templatePicker.empty')

    wrapper.unmount()
  })

  it('says so, without listing anything, when the request fails', async () => {
    const wrapper = mountDialog({ response: new Error('403') })
    await flushPromises()

    expect(document.body.textContent).toContain('pages.templatePicker.loadFailed')
    expect(document.body.querySelectorAll('.w-item')).toHaveLength(0)

    wrapper.unmount()
  })

  it('emits ok with the chosen template', async () => {
    const wrapper = mountDialog({
      response: [TEMPLATE, { ...TEMPLATE, id: 'tpl-2', name: 'Other' }]
    })
    await flushPromises()

    const items = document.body.querySelectorAll('.w-item')
    expect(items).toHaveLength(2)
    items[1].dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('ok')[0][0]).toEqual({
      template: expect.objectContaining({ id: 'tpl-2', name: 'Other' })
    })

    wrapper.unmount()
  })
})
