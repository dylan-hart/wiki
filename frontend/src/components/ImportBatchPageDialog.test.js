import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { TimeoutError } from 'ky'

import ImportBatchPageDialog from './ImportBatchPageDialog.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/*
  `WDialog` (and `WSelect`'s own `WMenu` popup) render through `<teleport to="body">`, so none of it
  is a descendant of the component's own root -- `wrapper.find()` never sees it. Every query below
  goes through the real `document.body` instead, wrapped the same way `@vue/test-utils` wraps its own
  results. Mirrors `ImportPageDialog.test.js`'s own helper.
*/
function body() {
  return new DOMWrapper(document.body)
}

/**
 * Defaults `GET system/extensions/status` to `{ pandoc: true }` -- most of this suite exercises a
 * Pandoc-backed format (`.docx` and friends), and OpenProject #1209's gating would otherwise disable
 * every one of them under the mock client's own unconfigured default (`json()` resolving `undefined`,
 * i.e. no extensions installed). A test that specifically covers the missing-Pandoc case overrides
 * this per-call, same as any other endpoint.
 */
async function mountDialog(props = {}, { pandocInstalled = true } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  // -> Skips `editorStore.fetchConfigs()`, an API call this suite has no interest in mocking --
  //    same pattern `InboxReview.test.js` uses for the same `MarkdownRenderer` config dependency
  useEditorStore().configIsLoaded = true
  globalThis.API_CLIENT.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue({ pandoc: pandocInstalled })
  })

  const i18n = createTestI18n()
  const router = buildTestRouter([])

  const wrapper = mount(ImportBatchPageDialog, {
    props: { basePath: 'docs', ...props },
    global: { plugins: [i18n, router] }
  })
  // -> `useDialogComponent` mounts hidden then flips visible on a following tick, so the teleported
  //    panel -- everything this test interacts with -- exists only after that tick runs, and
  //    `onMounted`'s `fetchExtensionsStatus()` needs its own tick to resolve too
  await flushPromises()
  return wrapper
}

async function selectFiles(files) {
  const input = body().find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, writable: false })
  await input.trigger('change')
}

/** A fake `FileSystemFileEntry`, as `.webkitGetAsEntry()` would return it for a dropped file. */
function makeFileEntry(name, content) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve) => resolve(new File([content], name, { type: 'text/markdown' }))
  }
}

/**
 * A fake `FileSystemDirectoryEntry` -- its `createReader().readEntries()` hands back `children` on
 * the first call and an empty array on every call after, the same "batches, terminated by empty"
 * contract the real one has.
 */
function makeDirEntry(name, children) {
  let exhausted = false
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (resolve) => {
        if (exhausted) {
          resolve([])
        } else {
          exhausted = true
          resolve(children)
        }
      }
    })
  }
}

/** Dispatches a real `drop` event carrying fake `FileSystemEntry` objects at the dropzone. */
async function dropEntries(entries) {
  const dropzone = body().find('.import-batch-dropzone').element
  const event = new Event('drop', { bubbles: true, cancelable: true })
  event.dataTransfer = {
    items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
    files: []
  }
  dropzone.dispatchEvent(event)
  await flushPromises()
}

/**
 * Opens the one visible `w-select` (only one is ever on screen at a time in this dialog) and picks
 * the option whose label matches. `optionText` is the raw i18n key, not translated prose — the test
 * harness mounts with empty messages, so `t(key)` renders back the key itself.
 */
async function chooseSelectOption(optionText) {
  await body().find('[role="combobox"]').trigger('click')
  const option = body()
    .findAll('[role="option"]')
    .find((el) => el.text() === optionText)
  await option.trigger('click')
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ImportBatchPageDialog', () => {
  it('leaves Convert All disabled until files with a recognized extension are chosen', async () => {
    await mountDialog()

    expect(body().find('.import-convert-btn').attributes('disabled')).toBeDefined()

    await selectFiles([
      new File(['a'], 'one.docx', { type: 'application/octet-stream' }),
      new File(['b'], 'two.docx', { type: 'application/octet-stream' })
    ])

    expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
  })

  it('lists chosen files and lets one be removed before converting', async () => {
    await mountDialog()
    await selectFiles([
      new File(['a'], 'one.docx', { type: 'application/octet-stream' }),
      new File(['b'], 'two.docx', { type: 'application/octet-stream' })
    ])

    let rows = body().findAll('.w-item')
    expect(rows).toHaveLength(2)

    await rows[0].find('[aria-label="common.actions.remove"]').trigger('click')

    rows = body().findAll('.w-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('two.docx')
  })

  it('converts every file in one multipart request and shows a row per result', async () => {
    const wrapper = await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        message: '1 of 2 file(s) converted successfully.',
        results: [
          { fileName: 'good.docx', ok: true, markdown: '# Good\n' },
          { fileName: 'bad.docx', ok: false, message: 'This file could not be converted.' }
        ]
      })
    })

    await selectFiles([
      new File(['a'], 'good.docx', { type: 'application/octet-stream' }),
      new File(['b'], 'bad.docx', { type: 'application/octet-stream' })
    ])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    const [url, opts] = globalThis.API_CLIENT.post.mock.calls[0]
    expect(url).toBe('sites/site-1/pages/import/batch')
    expect(opts.searchParams).toEqual({ path: 'docs' })
    expect(opts.body).toBeInstanceOf(FormData)
    expect(opts.body.getAll('files')).toHaveLength(2)
    // -> One `formats` field per file, autodetected from each one's own extension (OpenProject #1209)
    expect(opts.body.getAll('formats')).toEqual(['docx', 'docx'])

    const rows = body().findAll('.import-batch-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('good.docx')
    expect(rows[1].text()).toContain('bad.docx')
    expect(rows[1].text()).toContain('This file could not be converted.')

    // -> Convert-only: nothing is saved, and this dialog never hands content back like the
    //    single-file one does -- it saves through the ordinary create-page endpoint itself instead.
    expect(wrapper.emitted()).not.toHaveProperty('ok')
  })

  /**
   * OpenProject #1718: unlike `EXPORT_PDF_TIMEOUT`/`INSTALL_TIMEOUT`'s fixed ceilings, this request's
   * `timeout` is computed from the batch actually being sent -- mirrors `computeBatchImportTimeout`'s
   * three terms (base + per-file + per-byte, see that function's doc comment in the component) rather
   * than asserting a single hardcoded magic number, so this stays a real regression guard against the
   * *shape* of the scaling (does it grow with more/larger files at all), not brittle against a
   * deliberate future retuning of the constants themselves.
   */
  function expectedBatchImportTimeout(files) {
    const BASE = 40 * 1000
    const PER_FILE = 3 * 1000
    const BYTES_PER_MS = 100
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    return BASE + files.length * PER_FILE + Math.ceil(totalBytes / BYTES_PER_MS)
  }

  it('sends a timeout computed from the selected files, scaled by count and total size', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [{ fileName: 'good.docx', ok: true, markdown: '# Good\n' }]
      })
    })

    const files = [new File(['a'.repeat(5000)], 'good.docx', { type: 'application/octet-stream' })]
    await selectFiles(files)
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    const [, opts] = globalThis.API_CLIENT.post.mock.calls[0]
    expect(opts.timeout).toBe(expectedBatchImportTimeout(files))
  })

  it('sends a larger timeout for a bigger batch than for a single small file', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [{ fileName: 'one.docx', ok: true, markdown: '# One\n' }]
      })
    })
    await selectFiles([new File(['a'], 'one.docx', { type: 'application/octet-stream' })])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()
    const smallBatchTimeout = globalThis.API_CLIENT.post.mock.calls.at(-1)[1].timeout

    await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          { fileName: 'a.docx', ok: true, markdown: '# A\n' },
          { fileName: 'b.docx', ok: true, markdown: '# B\n' },
          { fileName: 'c.docx', ok: true, markdown: '# C\n' }
        ]
      })
    })
    const bigFiles = [
      new File(['x'.repeat(200_000)], 'a.docx', { type: 'application/octet-stream' }),
      new File(['y'.repeat(200_000)], 'b.docx', { type: 'application/octet-stream' }),
      new File(['z'.repeat(200_000)], 'c.docx', { type: 'application/octet-stream' })
    ]
    await selectFiles(bigFiles)
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()
    const bigBatchTimeout = globalThis.API_CLIENT.post.mock.calls.at(-1)[1].timeout

    expect(bigBatchTimeout).toBeGreaterThan(smallBatchTimeout)
    expect(bigBatchTimeout).toBe(expectedBatchImportTimeout(bigFiles))
  })

  it('shows a distinct timed-out toast for a client-side TimeoutError, telling the reader not to blindly retry', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw new TimeoutError({ method: 'POST', url: '/_api/sites/site-1/pages/import/batch' })
    })

    await selectFiles([new File(['a'], 'good.docx', { type: 'application/octet-stream' })])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    expect(body().findAll('.import-batch-row')).toHaveLength(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'pages.importBatch.convertTimedOut',
      caption: 'pages.importBatch.convertTimedOutHint'
    })
  })

  it('surfaces a failed batch-conversion request as a negative toast instead of advancing', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      const err = new Error('Pandoc missing')
      err.data = { message: 'Importing a page needs the Pandoc extension, which is not installed.' }
      throw err
    })

    await selectFiles([new File(['a'], 'good.docx', { type: 'application/octet-stream' })])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    expect(body().findAll('.import-batch-row')).toHaveLength(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'Importing a page needs the Pandoc extension, which is not installed.'
    })
  })

  async function convertOneGoodFile() {
    const wrapper = await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [{ fileName: 'good.docx', ok: true, markdown: '# Good\n' }]
      })
    })
    await selectFiles([new File(['a'], 'good.docx', { type: 'application/octet-stream' })])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('saves a converted row through the ordinary create-page endpoint, rendered HTML included', async () => {
    await convertOneGoodFile()

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'p1', path: 'docs/good' } })
    })
    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    const createCall = globalThis.API_CLIENT.post.mock.calls.at(-1)
    expect(createCall[0]).toBe('sites/site-1/pages')
    expect(createCall[1].json).toMatchObject({
      editor: 'markdown',
      path: 'docs/good',
      title: 'good',
      content: '# Good\n'
    })
    // -> Regression guard (OpenProject #849 fix): the markdown pipeline is a frontend concern
    //    (`renderers/markdown.js`), and a page view reads `pageStore.render`, not `content` -- a
    //    save with no `render` here published a page that showed blank to every reader.
    expect(createCall[1].json.render).toEqual(expect.stringContaining('Good'))
    expect(createCall[1].json.render).not.toBe('')
    expect(body().find('.import-batch-row').text()).toContain('Saved')
  })

  it('fails a row on its own when its markdown will not render, without touching the save endpoint', async () => {
    await convertOneGoodFile()
    // -> `MarkdownRenderer#render` throws on unparsable source; forcing that here proves a bad
    //    render fails only this row rather than the request never reaching `createPage` at all
    const renderSpy = vi
      .spyOn(await import('@/renderers/markdown'), 'MarkdownRenderer')
      .mockImplementation(() => ({
        render: () => {
          throw new Error('boom')
        }
      }))

    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    expect(body().find('.import-batch-row').text()).toContain('Failed')
    expect(body().find('.import-batch-row').text()).toContain('boom')
    expect(
      globalThis.API_CLIENT.post.mock.calls.filter((c) => c[0] === 'sites/site-1/pages')
    ).toHaveLength(0)
    renderSpy.mockRestore()
  })

  it('one row failing to save does not stop the others (independent per-file progress)', async () => {
    const wrapper = await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          { fileName: 'first.docx', ok: true, markdown: '# First\n' },
          { fileName: 'second.docx', ok: true, markdown: '# Second\n' }
        ]
      })
    })
    await selectFiles([
      new File(['a'], 'first.docx', { type: 'application/octet-stream' }),
      new File(['b'], 'second.docx', { type: 'application/octet-stream' })
    ])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()
    void wrapper

    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('database is unreachable')
    })
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'p2', path: 'docs/second' } })
    })

    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    const rows = body().findAll('.import-batch-row')
    expect(rows[0].text()).toContain('Failed')
    expect(rows[0].text()).toContain('database is unreachable')
    expect(rows[1].text()).toContain('Saved')
  })

  it("resolves a duplicate-path conflict by skipping the row when 'reject' is selected (the default)", async () => {
    await convertOneGoodFile()

    const conflict = new Error('A page already exists at this path.')
    conflict.response = { status: 409 }
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw conflict
    })

    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    expect(body().find('.import-batch-row').text()).toContain('Failed')
    // -> Only the one createPage attempt: 'reject' does not retry
    expect(
      globalThis.API_CLIENT.post.mock.calls.filter((c) => c[0] === 'sites/site-1/pages')
    ).toHaveLength(1)
  })

  it("resolves a duplicate-path conflict by retrying under a '-1' suffix when 'new' is selected", async () => {
    await convertOneGoodFile()
    await chooseSelectOption('pages.importBatch.conflictNew')

    const conflict = new Error('A page already exists at this path.')
    conflict.response = { status: 409 }
    globalThis.API_CLIENT.post
      .mockImplementationOnce(() => {
        throw conflict
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'p1', path: 'docs/good-1' } })
      })

    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    const createCalls = globalThis.API_CLIENT.post.mock.calls.filter(
      (c) => c[0] === 'sites/site-1/pages'
    )
    expect(createCalls).toHaveLength(2)
    expect(createCalls[1][1].json.path).toBe('docs/good-1')
    expect(body().find('.import-batch-row').text()).toContain('Saved')
  })

  it("resolves a duplicate-path conflict by fetching and patching the existing page when 'overwrite' is selected", async () => {
    await convertOneGoodFile()
    await chooseSelectOption('pages.importBatch.conflictOverwrite')

    const conflict = new Error('A page already exists at this path.')
    conflict.response = { status: 409 }
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw conflict
    })
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ id: 'existing-1', updatedAt: '2026-01-01T00:00:00.000Z' })
    })
    globalThis.API_CLIENT.patch.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'existing-1', path: 'docs/good' } })
    })

    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    // -> Looked up by the hash of its (normalized) path, same as `pageStore.pageLoad()` does
    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      expect.stringMatching(/^sites\/site-1\/pages\/[0-9a-f]+$/)
    )
    expect(globalThis.API_CLIENT.patch).toHaveBeenCalledWith(
      'sites/site-1/pages/existing-1',
      expect.objectContaining({
        json: expect.objectContaining({
          title: 'good',
          content: '# Good\n',
          expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
        })
      })
    )
    expect(body().find('.import-batch-row').text()).toContain('Saved')
  })

  it('accepts format=markdown, auto-detected from a .md extension, needing no Pandoc extension', async () => {
    await mountDialog()

    await selectFiles([new File(['# Hi'], 'notes.md', { type: 'text/markdown' })])

    expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
  })

  it('saves each row with the front matter title/description/tags a markdown import returned', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            fileName: 'notes.md',
            ok: true,
            markdown: '# Body\n',
            title: 'From Front Matter',
            description: 'A summary',
            tags: ['alpha', 'beta']
          }
        ]
      })
    })
    await selectFiles([new File(['---\ntitle: X\n---\n\n# Body\n'], 'notes.md')])
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, page: { id: 'p1', path: 'docs/from-front-matter' } })
    })
    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    const createCall = globalThis.API_CLIENT.post.mock.calls.at(-1)
    expect(createCall[1].json).toMatchObject({
      title: 'From Front Matter',
      description: 'A summary',
      tags: ['alpha', 'beta']
    })
  })

  it("preserves a dropped folder's structure into each row's default destination path (OpenProject #1092)", async () => {
    await mountDialog()
    const introEntry = makeFileEntry('intro.md', '# Intro')
    const guideDir = makeDirEntry('guide', [makeFileEntry('start.md', '# Start')])
    const notesDir = makeDirEntry('notes', [introEntry, guideDir])

    await dropEntries([notesDir])

    // -> Both files landed in the picker, and the markdown format auto-detected off their extension
    const fileRows = body().findAll('.w-item')
    expect(fileRows.map((r) => r.text())).toEqual([
      expect.stringContaining('intro.md'),
      expect.stringContaining('start.md')
    ])
    expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          { fileName: 'intro.md', ok: true, markdown: '# Intro\n' },
          { fileName: 'start.md', ok: true, markdown: '# Start\n' }
        ]
      })
    })
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    globalThis.API_CLIENT.post.mockReturnValue({
      json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'p', path: 'whatever' } })
    })
    await body().find('.import-batch-save-btn').trigger('click')
    await flushPromises()

    const createCalls = globalThis.API_CLIENT.post.mock.calls.filter(
      (c) => c[0] === 'sites/site-1/pages'
    )
    expect(createCalls).toHaveLength(2)
    expect(createCalls[0][1].json.path).toBe('docs/notes/intro')
    expect(createCalls[1][1].json.path).toBe('docs/notes/guide/start')
  })

  describe('per-file format detection and Pandoc availability (OpenProject #1209)', () => {
    it("autodetects each file's own format independently, not one shared by the whole batch", async () => {
      await mountDialog()
      await selectFiles([
        new File(['a'], 'one.docx', { type: 'application/octet-stream' }),
        new File(['b'], 'two.rst', { type: 'text/plain' })
      ])
      globalThis.API_CLIENT.post.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          ok: true,
          results: [
            { fileName: 'one.docx', ok: true, markdown: '# One\n' },
            { fileName: 'two.rst', ok: true, markdown: '# Two\n' }
          ]
        })
      })

      await body().find('.import-convert-btn').trigger('click')
      await flushPromises()

      const [, opts] = globalThis.API_CLIENT.post.mock.calls[0]
      expect(opts.body.getAll('formats')).toEqual(['docx', 'rst'])
    })

    it('allows a file with an unrecognized extension into the batch rather than blocking Convert All', async () => {
      await mountDialog()
      await selectFiles([new File(['a'], 'notes.xyz', { type: 'application/octet-stream' })])

      expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
    })

    it('grays out Pandoc-only formats in the per-file select, and shows an install hint, when Pandoc is missing', async () => {
      await mountDialog({}, { pandocInstalled: false })
      await selectFiles([new File(['a'], 'one.docx', { type: 'application/octet-stream' })])

      await body().find('[role="combobox"]').trigger('click')
      const docxOption = body()
        .findAll('[role="option"]')
        .find((el) => el.text().includes('Word Document'))
      expect(docxOption.attributes('aria-disabled')).toBe('true')
      expect(body().text()).toContain('pages.import.pandocMissing')
    })

    it('still allows converting when Pandoc is missing -- a Pandoc-needing row simply fails on its own', async () => {
      await mountDialog({}, { pandocInstalled: false })
      await selectFiles([new File(['a'], 'one.docx', { type: 'application/octet-stream' })])

      expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
    })
  })

  /**
   * OpenProject #1012: each new page in the batch can change what an `auto`/`mixed` menu generates
   * from the tree, the same as a single `pageSave()` create -- but this is a whole batch of them, so
   * `saveAll()` invalidates once at the end rather than once per row, which would re-trigger the tree
   * walk per row instead of per import.
   */
  describe('same-tab navigation invalidation (OpenProject #1012)', () => {
    it('force-refetches the sidebar nav once, after at least one row saved', async () => {
      const wrapper = await convertOneGoodFile()
      const pageStore = usePageStore()
      const siteStore = useSiteStore()
      pageStore.navigationId = 'nav-1'
      siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

      globalThis.API_CLIENT.post.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ ok: true, page: { id: 'p1', path: 'docs/good' } })
      })
      globalThis.API_CLIENT.get.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue([{ id: 'fresh' }])
      })

      await body().find('.import-batch-save-btn').trigger('click')
      await flushPromises()

      expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
      expect(siteStore.nav.items).toEqual([{ id: 'fresh' }])
      expect(wrapper.exists()).toBe(true)
    })

    it('does not touch the sidebar nav when every row failed to save', async () => {
      await convertOneGoodFile()
      const pageStore = usePageStore()
      const siteStore = useSiteStore()
      pageStore.navigationId = 'nav-1'
      siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

      globalThis.API_CLIENT.post.mockImplementationOnce(() => {
        throw new Error('network down')
      })
      globalThis.API_CLIENT.get.mockClear()

      await body().find('.import-batch-save-btn').trigger('click')
      await flushPromises()

      expect(globalThis.API_CLIENT.get).not.toHaveBeenCalled()
      expect(siteStore.nav.items).toEqual([{ id: 'stale' }])
    })
  })
})
