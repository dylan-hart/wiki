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

/**
 * The `import` utility used to be `disabled` with no handler at all (task 585). These tests cover the
 * two things it now does: picking a file opens the same destructive-action confirmation pattern as
 * `purgeHistory`/`invalidApiCertificates` (see `AdminUtilities.vue`'s other confirm() calls), and
 * confirming it uploads the file's raw bytes to `POST /_api/system/import`, scoped to the current
 * site — the same "body is the raw file, not a multipart form" shape `FileManager.vue` uses to upload
 * an asset.
 */

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
  'admin.utilities.disconnectWS': 'Disconnect WebSocket Clients',
  'admin.utilities.disconnectWSHint': 'Force all connected clients to reconnect.',
  'admin.utilities.purgeHistory': 'Purge Page History',
  'admin.utilities.purgeHistoryHint': 'Delete page history older than the selected timeframe.',
  'admin.utilities.purgeHistoryTimeframe': 'Timeframe',
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

/** Picks a fake `.tar.gz` through the hidden file input, the way a real user's file picker would. */
async function pickFile(wrapper) {
  const file = new File(['fake tarball bytes'], 'export.tar.gz', { type: 'application/gzip' })
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  return file
}

/**
 * The `export` utility used to be a permanently `disabled` button with no handler at all (WP 1214).
 * There is no separate status route for an export job — `GET /export/:jobId/download` itself answers
 * 409 while the job is still running — so `exportContent` polls that same download route until it
 * stops 409-ing, then saves whatever it resolves to.
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

    // -> Three polls of the download route: 409, 409, then the finished archive.
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

  /**
   * WP 1896: the export is a content export, not a backup — restoring it loses accounts, page
   * history, comments, settings, auth strategies, storage targets and site branding. Neither the
   * button's own hint nor the line naming what the archive omits may call it a backup.
   */
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

/**
 * The `scanPageProblems` utility used to be `disabled` with no handler (task 586). It queues a
 * background job, then polls `GET /_api/system/pages/scan/:jobId` — first `queued`/`active`, then
 * `completed` with the report — and shows that report inline rather than as a toast, since a scan's
 * whole value is the list of what it found.
 */
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

    // -> Three polls: queued, active, completed — each gated behind the poll interval
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

/**
 * The Cardinal settings pattern, as it reaches a TOOL page —
 * `docs/decisions/admin-list-viewer-tool-page-pattern.md`.
 *
 * Each of these ten utilities is a fixed, design-time named action: a plate, a label over a
 * sentence, and one control at the trailing edge. That is the settings row's own shape, so the page
 * draws them with `WSettingsRow` rather than the hand-written `WItem` + `BlueprintIcon` + two
 * `WItemSection` + two `WItemLabel` stack it used to. What it deliberately does NOT take is a header
 * strip on the tool card (the page header above already names it) — while the scan-results card,
 * which the page header does not name, does take one.
 */
describe('AdminUtilities settings pattern', () => {
  it('draws every tool as a settings row with a plate, a label and one trailing control', async () => {
    const wrapper = await mountUtilities()
    const rows = wrapper.findAll('.w-settings-row')

    expect(rows).toHaveLength(10)
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

    // -> The tool list's own `WItem`s are gone. The scan report's expansion list is not mounted
    //    here (no report yet), so the page should hold none at all.
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
    // -> One control cell, not two: `WSettingsRow` has a single trailing slot by design.
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
