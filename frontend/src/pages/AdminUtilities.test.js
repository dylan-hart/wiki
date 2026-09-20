import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import AdminUtilities from './AdminUtilities.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

const messages = {
  'admin.utilities.title': 'Utilities',
  'admin.utilities.subtitle': '',
  'admin.utilities.export': 'Export',
  'admin.utilities.exportHint': "Export this site's pages, files and folders to a tarball.",
  'admin.utilities.exportExclusions':
    'Does not include accounts, page history, comments, settings, authentication strategies, storage targets or site branding. See docs/operations.md for the full recovery procedure.',
  'admin.utilities.exportSuccess': 'Content export saved.',
  'admin.utilities.exportFailed': "Failed to export the site's content.",
  'admin.utilities.import': 'Import',
  'admin.utilities.importHint': '',
  'admin.utilities.importConfirm': "This will replace {site}'s content.",
  'admin.utilities.importConfirmWarn': 'This cannot be undone.',
  'admin.utilities.importSuccess': 'Content import queued successfully.',
  'admin.utilities.importFailed': 'Failed to queue the content import.',
  'admin.utilities.scanPageProblems': 'Scan for Page Problems',
  'admin.utilities.scanPageProblemsHint': '',
  'admin.utilities.scanPageProblemsResults': 'Scan results',
  'admin.utilities.scanPageProblemsScannedAt': 'Scanned {date}',
  'admin.utilities.scanPageProblemsNone': 'No problems found.',
  'admin.utilities.scanPageProblemsHashDrift': 'Hash drift',
  'admin.utilities.scanPageProblemsTreeDivergence': 'Tree / page divergence',
  'admin.utilities.scanPageProblemsDuplicatePaths': 'Duplicate paths',
  'admin.utilities.scanPageProblemsBrokenRelations': 'Broken relations',
  'admin.utilities.scanPageProblemsLocaleCollisions': 'Locale-code collisions',
  'admin.utilities.scanPageProblemsOrphanTreeEntry': '/{path} — has no matching page',
  'admin.utilities.scanPageProblemsOrphanPageRow': '/{path} — has no matching tree entry',
  'admin.utilities.scanPageProblemsFailed': 'The scan could not be completed.',
  'admin.utilities.wysiwygConvert': 'Convert Legacy WYSIWYG Content',
  'admin.utilities.wysiwygConvertHint': '',
  'admin.utilities.wysiwygConvertResults': 'Conversion results',
  'admin.utilities.wysiwygConvertConvertedCount':
    'No pages converted. | 1 page converted. | {count} pages converted.',
  'admin.utilities.wysiwygConvertNone': 'Nothing left to report — every converted row succeeded.',
  'admin.utilities.wysiwygConvertFailed': 'The conversion could not be completed.',
  'admin.utilities.disconnectWS': 'Disconnect WebSocket Clients',
  'admin.utilities.disconnectWSHint': 'Force all connected clients to reconnect.',
  'admin.utilities.purgeHistory': 'Purge Page History',
  'admin.utilities.purgeHistoryHint': 'Delete page history older than the selected timeframe.',
  'admin.utilities.purgeHistoryTimeframe': 'Timeframe',
  'admin.utilities.purgeEmptyFolders': 'Purge Empty Folders',
  'admin.utilities.purgeEmptyFoldersHint': 'Delete folders that hold no pages, files or folders.',
  'admin.utilities.purgeEmptyFoldersConfirm':
    '1 empty folder will be deleted. | {count} empty folders will be deleted.',
  'admin.utilities.purgeEmptyFoldersConfirmWarn': 'This cannot be undone.',
  'admin.utilities.purgeEmptyFoldersSuccess':
    'No empty folders deleted. | 1 empty folder deleted. | {count} empty folders deleted.',
  'admin.utilities.purgeEmptyFoldersNone': 'There are no empty folders to purge.',
  'admin.utilities.purgeEmptyFoldersFailed': 'Failed to purge the empty folders.',
  'common.actions.proceed': 'Proceed',
  'common.actions.viewDocs': 'View docs'
}

async function mountUtilities() {
  const router = await createTestRouter(['/'])

  return mountWithApp(AdminUtilities, {
    messages,
    router,
    stores: { site: { id: 'aaaaaaaa-0000-4000-8000-000000000001', hostname: 'example.com' } }
  }).wrapper
}

/** An input's `files` is read-only, so the picked file is defined onto the element directly. */
async function pickFile(wrapper) {
  const file = new File(['fake tarball bytes'], 'export.tar.gz', { type: 'application/gzip' })
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  return file
}

/**
 * There is no separate status route for an export job — `GET /export/:jobId/download` itself answers
 * 409 while the job is still running — so `exportContent` polls that same download route until it
 * stops 409-ing.
 */
describe('AdminUtilities export', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fileSave.mockClear()
    notifyQueue.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function conflictError() {
    return Object.assign(new Error('Conflict'), { response: { status: 409 } })
  }

  it('queues an export for the current site and polls the download route until it saves the file', async () => {
    const wrapper = await mountUtilities()
    const blob = new Blob(['fake tarball bytes'], { type: 'application/gzip' })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-5' })
    })
    API_CLIENT.get
      .mockReturnValueOnce({ blob: () => Promise.reject(conflictError()) })
      .mockReturnValueOnce({ blob: () => Promise.reject(conflictError()) })
      .mockReturnValueOnce({ blob: () => Promise.resolve(blob) })

    await wrapper.find('[aria-label="Export"]').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('system/export', {
      json: { siteId: 'aaaaaaaa-0000-4000-8000-000000000001' }
    })

    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)
    expect(API_CLIENT.get).toHaveBeenCalledWith('system/export/job-5/download')
    expect(fileSave).toHaveBeenCalledWith(
      blob,
      expect.objectContaining({ fileName: 'export-job-5.tar.gz' })
    )
  })

  /** A content export, not a backup: restoring it loses accounts, history, comments and settings. */
  it('does not call the export a backup, and names what the archive omits', async () => {
    const wrapper = await mountUtilities()

    expect(wrapper.text()).not.toMatch(/backup/i)
    expect(wrapper.text()).toContain("Export this site's pages, files and folders to a tarball.")
    expect(wrapper.text()).toContain(
      'Does not include accounts, page history, comments, settings, authentication strategies, storage targets or site branding.'
    )
    expect(wrapper.text()).toContain('docs/operations.md for the full recovery procedure.')
  })

  it('shows an error when the download route fails for a reason other than "not ready yet"', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-6' })
    })
    API_CLIENT.get.mockReturnValueOnce({
      blob: () => Promise.reject(new Error('Server error'))
    })

    await wrapper.find('[aria-label="Export"]').trigger('click')
    await flushPromises()

    expect(fileSave).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: "Failed to export the site's content."
    })
  })
})

describe('AdminUtilities import', () => {
  it('opens a destructive-action confirmation once a file is picked, before uploading anything', async () => {
    const wrapper = await mountUtilities()

    expect(openDialogs.length).toBe(0)
    await pickFile(wrapper)

    expect(openDialogs.length).toBe(1)
    expect(openDialogs[0].props.title).toBe('Import')
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.persistent).toBe(true)
    expect(API_CLIENT.post).not.toHaveBeenCalled()

    closeDialog(openDialogs[0].id, false)
  })

  it('uploads the picked file to the current site once confirmed', async () => {
    const wrapper = await mountUtilities()
    const file = await pickFile(wrapper)

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-1' })
    })

    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'system/import',
      expect.objectContaining({
        searchParams: { targetSiteId: 'aaaaaaaa-0000-4000-8000-000000000001' },
        body: file
      })
    )
  })

  it('does not upload when the confirmation is cancelled', async () => {
    const wrapper = await mountUtilities()
    await pickFile(wrapper)

    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })
})

describe('AdminUtilities scanPageProblems', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const sampleReport = {
    hashDrift: {
      count: 1,
      entries: [
        {
          id: 'p1',
          siteId: 's1',
          locale: 'en',
          path: 'drifted',
          storedHash: 'a',
          expectedHash: 'b'
        }
      ]
    },
    treeDivergence: { count: 0, entries: [] },
    duplicatePaths: { count: 0, entries: [] },
    brokenRelations: { count: 0, entries: [] },
    localeCollisions: {
      count: 1,
      entries: [
        {
          table: 'pages',
          id: 'p2',
          siteId: 's1',
          locale: 'en',
          path: 'fr/shadowed',
          collidingCode: 'fr'
        }
      ]
    },
    scannedAt: '2026-08-17T00:00:00.000Z'
  }

  it('queues the scan and polls until completion, then shows the report', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-2' })
    })
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => Promise.resolve({ state: 'queued', result: null }) })
      .mockReturnValueOnce({ json: () => Promise.resolve({ state: 'active', result: null }) })
      .mockReturnValueOnce({
        json: () => Promise.resolve({ state: 'completed', result: sampleReport })
      })

    const button = wrapper.find('[aria-label="Scan for Page Problems"]')
    await button.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('system/pages/scan')

    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)
    expect(API_CLIENT.get).toHaveBeenCalledWith('system/pages/scan/job-2')
    expect(wrapper.text()).toContain('Scan results')
    expect(wrapper.text()).toContain('Hash drift (1)')
    expect(wrapper.text()).toContain('/drifted — stored a, expected b')
    expect(wrapper.text()).toContain('Locale-code collisions (1)')
    expect(wrapper.text()).toContain('[pages] /fr/shadowed (en) — starts with locale code "fr"')
    expect(wrapper.text()).not.toContain('No problems found.')
  })

  it('shows "no problems found" for a clean report', async () => {
    const wrapper = await mountUtilities()
    const cleanReport = {
      hashDrift: { count: 0, entries: [] },
      treeDivergence: { count: 0, entries: [] },
      duplicatePaths: { count: 0, entries: [] },
      brokenRelations: { count: 0, entries: [] },
      localeCollisions: { count: 0, entries: [] },
      scannedAt: '2026-08-17T00:00:00.000Z'
    }
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-4' })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ state: 'completed', result: cleanReport })
    })

    await wrapper.find('[aria-label="Scan for Page Problems"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(wrapper.text()).toContain('No problems found.')
  })

  it('shows an error and no report when the job fails', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-3' })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ state: 'failed', result: null })
    })

    const button = wrapper.find('[aria-label="Scan for Page Problems"]')
    await button.trigger('click')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(wrapper.text()).not.toContain('Scan results')
  })
})

describe('AdminUtilities convertWysiwygJson', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues the conversion and polls until completion, then shows the report', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-9' })
    })
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => Promise.resolve({ state: 'queued', result: null }) })
      .mockReturnValueOnce({ json: () => Promise.resolve({ state: 'active', result: null }) })
      .mockReturnValueOnce({
        json: () =>
          Promise.resolve({
            state: 'completed',
            result: {
              convertedCount: 3,
              failed: [
                {
                  siteId: 's1',
                  id: 'p1',
                  path: 'broken',
                  locale: 'en',
                  reason: 'Not a Tiptap document: missing a top-level "doc" node.'
                }
              ]
            }
          })
      })

    const button = wrapper.find('[aria-label="Convert Legacy WYSIWYG Content"]')
    await button.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('system/wysiwyg/convert')

    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)
    expect(API_CLIENT.get).toHaveBeenCalledWith('system/wysiwyg/convert/job-9')
    expect(wrapper.text()).toContain('Conversion results')
    expect(wrapper.text()).toContain('3 pages converted.')
    expect(wrapper.text()).toContain(
      '/broken (en) — Not a Tiptap document: missing a top-level "doc" node.'
    )
    expect(wrapper.text()).not.toContain('Nothing left to report')
  })

  it('shows the "nothing left to report" state when every row converted', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-10' })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ state: 'completed', result: { convertedCount: 2, failed: [] } })
    })

    await wrapper.find('[aria-label="Convert Legacy WYSIWYG Content"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(wrapper.text()).toContain('2 pages converted.')
    expect(wrapper.text()).toContain('Nothing left to report')
  })

  it('shows an error and no report when the job fails', async () => {
    const wrapper = await mountUtilities()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-11' })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ state: 'failed', result: null })
    })

    await wrapper.find('[aria-label="Convert Legacy WYSIWYG Content"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(wrapper.text()).not.toContain('Conversion results')
  })
})

describe('AdminUtilities purgeEmptyFolders', () => {
  const SITE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
  const URL = `sites/${SITE_ID}/tree/folders/purge-empty`

  beforeEach(() => {
    notifyQueue.length = 0
  })

  async function clickPurge(wrapper) {
    const row = wrapper
      .findAll('.w-settings-row')
      .find((r) => r.find('.w-settings-row__label').text() === 'Purge Empty Folders')
    await row.find('button').trigger('click')
    await flushPromises()
  }

  function respondWith(...bodies) {
    for (const body of bodies) {
      API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(body) })
    }
  }

  it('draws the row with a hint and a trailing control', async () => {
    const wrapper = await mountUtilities()
    const row = wrapper
      .findAll('.w-settings-row')
      .find((r) => r.find('.w-settings-row__label').text() === 'Purge Empty Folders')

    expect(row).toBeTruthy()
    expect(row.find('.w-settings-row__hint').text()).toBe(
      'Delete folders that hold no pages, files or folders.'
    )
    expect(row.find('.w-settings-row__control').text()).toContain('Proceed')
  })

  it('runs a dry run first, notifies and opens no confirmation when nothing is empty', async () => {
    const wrapper = await mountUtilities()
    respondWith({ dryRun: true, count: 0, folders: [] })

    await clickPurge(wrapper)

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.post).toHaveBeenCalledWith(URL, { json: { dryRun: true } })
    expect(openDialogs.length).toBe(0)
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ message: 'There are no empty folders to purge.' })
  })

  it('confirms with the dry-run count, before deleting anything', async () => {
    const wrapper = await mountUtilities()
    respondWith({ dryRun: true, count: 3, folders: [] })

    await clickPurge(wrapper)

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(openDialogs.length).toBe(1)
    expect(openDialogs[0].props.title).toBe('Purge Empty Folders')
    expect(openDialogs[0].props.message).toBe('3 empty folders will be deleted.')
    expect(openDialogs[0].props.caption).toBe('This cannot be undone.')
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.persistent).toBe(true)

    closeDialog(openDialogs[0].id, false)
  })

  it('sends dryRun false once confirmed and reports what was removed', async () => {
    const wrapper = await mountUtilities()
    respondWith({ dryRun: true, count: 3, folders: [] }, { dryRun: false, count: 2, folders: [] })

    await clickPurge(wrapper)
    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)
    expect(API_CLIENT.post).toHaveBeenLastCalledWith(URL, { json: { dryRun: false } })
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: '2 empty folders deleted.'
    })
  })

  it('sends no second call when the confirmation is cancelled', async () => {
    const wrapper = await mountUtilities()
    respondWith({ dryRun: true, count: 3, folders: [] })

    await clickPurge(wrapper)
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
  })

  it('shows the failed message when the dry run fails', async () => {
    const wrapper = await mountUtilities()
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(new Error('boom')) })

    await clickPurge(wrapper)

    expect(openDialogs.length).toBe(0)
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Failed to purge the empty folders.'
    })
  })

  it('shows the failed message when the confirmed purge fails', async () => {
    const wrapper = await mountUtilities()
    respondWith({ dryRun: true, count: 3, folders: [] })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(new Error('boom')) })

    await clickPurge(wrapper)
    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to purge the empty folders.'
    })
  })
})

describe('AdminUtilities settings pattern', () => {
  it('draws every tool as a settings row with a plate, a label and one trailing control', async () => {
    const wrapper = await mountUtilities()
    const rows = wrapper.findAll('.w-settings-row')

    expect(rows).toHaveLength(12)
    for (const row of rows) {
      expect(row.find('.blueprint-icon').exists()).toBe(true)
      expect(row.find('.w-settings-row__label').text()).not.toBe('')
      expect(row.find('.w-settings-row__control').exists()).toBe(true)
    }

    const disconnect = rows[0]
    expect(disconnect.find('.w-settings-row__label').text()).toBe('Disconnect WebSocket Clients')
    expect(disconnect.find('.w-settings-row__hint').text()).toBe(
      'Force all connected clients to reconnect.'
    )
    expect(disconnect.find('.w-settings-row__control').text()).toContain('Proceed')
  })

  it('leaves no hand-written list row behind', async () => {
    const wrapper = await mountUtilities()

    // -> The scan report's expansion list is not mounted yet, so no `.w-item` should exist at all.
    expect(wrapper.findAll('.w-item')).toHaveLength(0)
  })

  it('keeps the two-control purge-history row in one trailing slot', async () => {
    const wrapper = await mountUtilities()
    const row = wrapper
      .findAll('.w-settings-row')
      .find((r) => r.find('.w-settings-row__label').text() === 'Purge Page History')

    expect(row).toBeTruthy()
    const control = row.find('.w-settings-row__control')
    expect(control.find('select, input, [role="combobox"]').exists()).toBe(true)
    expect(control.text()).toContain('Proceed')
    expect(row.findAll('.w-settings-row__control')).toHaveLength(1)
  })

  it('gives the tool card no header strip and the scan-results card one', async () => {
    const wrapper = await mountUtilities()

    expect(wrapper.findAll('.w-section-header')).toHaveLength(0)

    vi.useFakeTimers()
    try {
      API_CLIENT.post.mockReturnValueOnce({
        json: () => Promise.resolve({ ok: true, id: 'job-6' })
      })
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve({
            state: 'completed',
            result: {
              hashDrift: { count: 0, entries: [] },
              treeDivergence: { count: 0, entries: [] },
              duplicatePaths: { count: 0, entries: [] },
              brokenRelations: { count: 0, entries: [] },
              localeCollisions: { count: 0, entries: [] },
              scannedAt: '2026-08-17T00:00:00.000Z'
            }
          })
      })

      await wrapper.find('[aria-label="Scan for Page Problems"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(1500)
      await flushPromises()
    } finally {
      vi.useRealTimers()
    }

    const headers = wrapper.findAll('.w-section-header')
    expect(headers).toHaveLength(1)
    expect(headers[0].text()).toContain('Scan results')
    expect(headers[0].find('.w-card-header__hint').text()).toContain('Scanned')
  })
})
