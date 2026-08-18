import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import { fileSave } from 'browser-fs-access'

import PageActionsCol from './PageActionsCol.vue'
import { useUserStore } from '@/stores/user'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

const EXPORT_BTN = '.page-actions-export-pdf-btn'

/**
 * Mounts the rail with a page and site already loaded. Queues the `system/extensions/status`
 * response the `onMounted` hook's own `fetchExtensionsStatus()` call consumes -- the same call
 * `PageNewMenu`'s own test exercises for the Pandoc equivalent -- so a test that also needs to mock
 * the export request itself must queue that AFTER calling this, once the status call has already
 * consumed the first queued response.
 */
async function mountRail({ pagePermissions = [], puppeteer = true } = {}) {
  setActivePinia(createPinia())

  const userStore = useUserStore()
  userStore.pagePermissions = pagePermissions

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'en/getting-started'
  pageStore.title = 'Getting Started'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  globalThis.API_CLIENT.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue({ puppeteer })
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(PageActionsCol, {
    global: { plugins: [router, i18n] }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
  vi.mocked(fileSave).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PageActionsCol: Export to PDF', () => {
  it('fetches the extensions status once mounted, to decide whether to show itself', async () => {
    await mountRail()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('system/extensions/status')
  })

  it('hides the button when the Puppeteer extension is not installed', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: false })

    expect(wrapper.find(EXPORT_BTN).exists()).toBe(false)
  })

  it('hides the button without read:pages on this page', async () => {
    const wrapper = await mountRail({ pagePermissions: [], puppeteer: true })

    expect(wrapper.find(EXPORT_BTN).exists()).toBe(false)
  })

  it('shows the button when read:pages is granted and Puppeteer is installed', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    expect(wrapper.find(EXPORT_BTN).exists()).toBe(true)
  })

  it('requests the PDF as a blob and saves it named after the page path', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' })
    const blobFn = vi.fn().mockResolvedValue(blob)
    globalThis.API_CLIENT.get.mockReturnValueOnce({ blob: blobFn })

    await wrapper.find(EXPORT_BTN).trigger('click')
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/page-1/export/pdf',
      expect.objectContaining({ timeout: expect.any(Number) })
    )
    expect(blobFn).toHaveBeenCalled()
    expect(fileSave).toHaveBeenCalledWith(
      blob,
      expect.objectContaining({ fileName: 'getting-started.pdf' })
    )
  })

  it('shows a loading state while the export request is in flight', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    let resolveBlob
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      blob: () => new Promise((resolve) => (resolveBlob = resolve))
    })

    const btn = wrapper.find(EXPORT_BTN)
    await btn.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find(EXPORT_BTN).attributes('aria-busy')).toBe('true')

    resolveBlob(new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
    await flushPromises()

    expect(wrapper.find(EXPORT_BTN).attributes('aria-busy')).toBeUndefined()
  })

  it('does not notify when the reader dismisses the save-as picker', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    globalThis.API_CLIENT.get.mockReturnValueOnce({
      blob: vi.fn().mockResolvedValue(new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
    })
    vi.mocked(fileSave).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    )

    await wrapper.find(EXPORT_BTN).trigger('click')
    await flushPromises()

    expect(notifyQueue).toHaveLength(0)
  })

  it('surfaces a distinct message when Puppeteer is not installed', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    globalThis.API_CLIENT.get.mockReturnValueOnce({
      blob: vi.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 503'), {
          name: 'HTTPError',
          data: { ok: false, error: 'exportPuppeteerMissing', statusCode: 503, message: 'nope' }
        })
      )
    })

    await wrapper.find(EXPORT_BTN).trigger('click')
    await flushPromises()

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].message).toBe('pages.export.puppeteerMissing')
  })

  it('surfaces a generic export-failed message for anything else', async () => {
    const wrapper = await mountRail({ pagePermissions: ['read:pages'], puppeteer: true })

    globalThis.API_CLIENT.get.mockReturnValueOnce({
      blob: vi.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 500'), {
          name: 'HTTPError',
          data: { ok: false, error: 'Internal Server Error', statusCode: 500, message: 'boom' }
        })
      )
    })

    await wrapper.find(EXPORT_BTN).trigger('click')
    await flushPromises()

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].message).toBe('pages.export.failed')
    expect(notifyQueue[0].caption).toBe('boom')
  })
})
