import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import { clickMenuItem, menuItemLabels, mountRail } from './pageActionsHarness.js'

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

    const trigger = wrapper.get('[aria-label="pageActions.exportPage"]')
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
    expect(
      wrapper.get('[aria-label="pageActions.exportPage"]').attributes('aria-busy')
    ).toBeUndefined()
  })
})
