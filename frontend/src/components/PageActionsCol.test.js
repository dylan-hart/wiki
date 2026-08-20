import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import PageActionsCol from './PageActionsCol.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { useEditorStore } from '@/stores/editor'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * Task 502: the standalone "Page Source" rail button is retired in favour of a single "Export Page"
 * `w-menu` offering Markdown / HTML / PDF, matching the pattern the "..." Page Actions menu below it
 * already uses. `w-menu`'s panel is teleported to `document.body` (see `WMenu.vue`), so once the
 * trigger is clicked the panel has to be queried off `document`, not off `wrapper` -- `wrapper.find`
 * only ever searches the mounted root's own subtree.
 */
async function mountRail({ pdfExportAvailable = false } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'docs/getting-started'
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.pdfExportAvailable = pdfExportAvailable

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  const trigger = wrapper.get('[aria-label="Export Page"]')
  await trigger.trigger('click')
  await flushPromises()

  return { wrapper, pageStore, siteStore }
}

function menuItemLabels() {
  return [...document.querySelectorAll('.w-menu .w-item')].map((el) => el.textContent.trim())
}

function clickMenuItem(label) {
  const item = [...document.querySelectorAll('.w-menu .w-item')].find((el) =>
    el.textContent.includes(label)
  )
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * OpenProject #811: an unsaved (never-saved) page has no `pageStore.id` yet, so clicking Page
 * History must not open the overlay -- there is nothing for it to fetch. Its own mount setup, since
 * the "Page History" button is gated on `read:history` (see PageActionsCol.vue), which `mountRail`
 * above never grants.
 */
async function mountRailWithHistory({ pageId = 'page-1', creating = false } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = pageId
  pageStore.path = 'docs/getting-started'
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const userStore = useUserStore()
  userStore.permissions = ['read:history']

  // -> The ticket's actual scenario: a brand-new, never-saved page, still open in the editor
  if (creating) {
    const editorStore = useEditorStore()
    editorStore.isActive = true
    editorStore.mode = 'create'
  }

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

describe('PageActionsCol page history button', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('opens the History overlay when the page has been saved', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: 'page-1' }))

    await wrapper.get('[aria-label="Page History"]').trigger('click')

    expect(ctx.siteStore.overlay).toBe('PageHistory')
    expect(notifyQueue).toHaveLength(0)
  })

  it('notifies instead of opening the overlay for an unsaved page with no id', async () => {
    let ctx
    // -> '' is the store's real default (page.js), not a stand-in like `null` -- a never-saved page
    //    has literally never been assigned an id
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: '', creating: true }))

    await wrapper.get('[aria-label="Page History"]').trigger('click')

    expect(ctx.siteStore.overlay).toBeNull()
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'info' })
  })
})

describe('PageActionsCol export menu', () => {
  let wrapper

  beforeEach(() => {
    API_CLIENT.get.mockReturnValue({
      text: vi.fn().mockResolvedValue(''),
      blob: vi.fn().mockResolvedValue(new Blob())
    })
    fileSave.mockClear()
    fileSave.mockResolvedValue(undefined)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('offers Markdown and HTML, but hides PDF when the site has no server-side rendering', async () => {
    ;({ wrapper } = await mountRail({ pdfExportAvailable: false }))

    const labels = menuItemLabels()
    expect(labels).toContain('Markdown')
    expect(labels).toContain('HTML')
    expect(labels).not.toContain('PDF')
  })

  it('shows PDF once the site surfaces it as available', async () => {
    ;({ wrapper } = await mountRail({ pdfExportAvailable: true }))

    expect(menuItemLabels()).toContain('PDF')
  })

  it('downloads Markdown via the export endpoint, named off the page path', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })

    clickMenuItem('Markdown')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export`,
      { searchParams: { format: 'markdown' } }
    )
    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob.type).toBe('text/markdown')
    expect(opts).toMatchObject({ fileName: 'getting-started.md', extensions: ['.md'] })
  })

  it('downloads HTML via the export endpoint', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('<p>Hi</p>') })

    clickMenuItem('HTML')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export`,
      { searchParams: { format: 'html' } }
    )
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob.type).toBe('text/html')
    expect(opts).toMatchObject({ fileName: 'getting-started.html', extensions: ['.html'] })
  })

  it('falls back to "home" for the file name when the page path is empty', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    ctx.pageStore.path = ''
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Home') })

    clickMenuItem('Markdown')
    await flushPromises()

    const [, opts] = fileSave.mock.calls[0]
    expect(opts.fileName).toBe('home.md')
  })

  /**
   * PDF is the one export that genuinely takes several real seconds (a headless Chromium render of
   * the live page view, per `models/pdfExport.ts`) rather than an instant client-side Blob, so the
   * button carries `w-btn`'s own `loading` state for the duration -- this is the "loading spinner
   * while Chromium renders" the task calls for, and it also disables the button so a second click
   * during the wait can't fire a second render.
   */
  it('shows a loading spinner on the Export button while the PDF request is in flight, and hits /export/pdf', async () => {
    let resolveBlob
    const blobPromise = new Promise((resolve) => {
      resolveBlob = resolve
    })
    let ctx
    ;({ wrapper } = ctx = await mountRail({ pdfExportAvailable: true }))
    API_CLIENT.get.mockReturnValueOnce({ blob: vi.fn().mockReturnValue(blobPromise) })

    clickMenuItem('PDF')
    await flushPromises()

    const trigger = wrapper.get('[aria-label="Export Page"]')
    expect(trigger.attributes('aria-busy')).toBe('true')
    expect(trigger.attributes('disabled')).toBeDefined()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export/pdf`,
      expect.objectContaining({ timeout: expect.any(Number) })
    )

    resolveBlob(new Blob(['%PDF'], { type: 'application/pdf' }))
    await flushPromises()

    expect(trigger.attributes('aria-busy')).toBeUndefined()
    expect(fileSave).toHaveBeenCalledTimes(1)
    const [, opts] = fileSave.mock.calls[0]
    expect(opts).toMatchObject({ fileName: 'getting-started.pdf', extensions: ['.pdf'] })
  })

  it('does not treat a cancelled save picker (AbortError) as a failure', async () => {
    ;({ wrapper } = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })
    fileSave.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

    clickMenuItem('Markdown')
    await flushPromises()

    // -> No throw, and the trigger stays interactive: the earlier PDF test covers the failure path
    expect(wrapper.get('[aria-label="Export Page"]').attributes('aria-busy')).toBeUndefined()
  })
})
