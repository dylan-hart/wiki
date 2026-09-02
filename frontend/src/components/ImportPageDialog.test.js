import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { TimeoutError } from 'ky'

import ImportPageDialog from './ImportPageDialog.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/*
  `WDialog` renders its panel through `<teleport to="body">`, so none of it is a descendant of the
  component's own root -- `wrapper.find()` never sees it. Every query below goes through the real
  `document.body` instead, wrapped the same way `@vue/test-utils` wraps its own results.
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
  globalThis.API_CLIENT.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue({ pandoc: pandocInstalled })
  })

  const i18n = createTestI18n()
  const router = buildTestRouter([])

  const wrapper = mount(ImportPageDialog, {
    props: { basePath: 'docs', ...props },
    global: { plugins: [i18n, router] }
  })
  // -> `useDialogComponent` mounts hidden then flips visible on a following tick, so the teleported
  //    panel -- everything this test interacts with -- exists only after that tick runs, and
  //    `onMounted`'s `fetchExtensionsStatus()` needs its own tick to resolve too
  await flushPromises()
  return wrapper
}

async function selectFile(file) {
  const input = body().find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], writable: false })
  await input.trigger('change')
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ImportPageDialog', () => {
  it('leaves Convert disabled until a file with a recognized extension is chosen', async () => {
    await mountDialog()

    expect(body().find('.import-convert-btn').attributes('disabled')).toBeDefined()

    await selectFile(
      new File(['hello'], 'notes.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      })
    )

    // -> `.docx` auto-detects a format, so Convert enables without touching the format select
    expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
  })

  it('converts the file, shows the returned Markdown, and hands it off on confirm', async () => {
    const wrapper = await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, markdown: '# Converted heading\n' })
    })

    const file = new File(['hello'], 'notes.docx', { type: 'application/octet-stream' })
    await selectFile(file)
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/pages/import',
      expect.objectContaining({
        // -> A named, work-sized timeout rather than ky's 10s default (OpenProject #1718) -- the
        //    exact value is an internal implementation detail, just that one was sent at all
        timeout: expect.any(Number),
        searchParams: { fileName: 'notes.docx', format: 'docx', path: 'docs' },
        headers: { 'content-type': 'application/octet-stream' },
        body: file
      })
    )
    // -> `.text()` trims outer whitespace; the underlying element still holds the trailing newline
    //    pandoc's output ends with
    expect(body().find('pre').element.textContent).toBe('# Converted heading\n')

    await body().find('.import-confirm-btn').trigger('click')

    expect(wrapper.emitted('ok')).toEqual([
      [{ content: '# Converted heading\n', title: 'notes', description: '', tags: [] }]
    ])
  })

  it('auto-detects the markdown format from a .md extension, needing no Pandoc extension', async () => {
    await mountDialog()
    await selectFile(new File(['# Hi'], 'notes.md', { type: 'text/markdown' }))

    expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
  })

  it('prefers the front matter title/description/tags a markdown import returns over the file name default', async () => {
    const wrapper = await mountDialog()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        markdown: '# Body\n',
        title: 'From Front Matter',
        description: 'A summary',
        tags: ['alpha', 'beta']
      })
    })

    await selectFile(new File(['---\ntitle: From Front Matter\n---\n\n# Body\n'], 'notes.md'))
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    await body().find('.import-confirm-btn').trigger('click')

    expect(wrapper.emitted('ok')).toEqual([
      [
        {
          content: '# Body\n',
          title: 'From Front Matter',
          description: 'A summary',
          tags: ['alpha', 'beta']
        }
      ]
    ])
  })

  it('surfaces a failed conversion as a negative toast instead of advancing to the preview', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      const err = new Error('Pandoc missing')
      err.data = { message: 'Importing a page needs the Pandoc extension, which is not installed.' }
      throw err
    })

    const file = new File(['hello'], 'notes.docx', { type: 'application/octet-stream' })
    await selectFile(file)
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    expect(body().find('pre').exists()).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'Importing a page needs the Pandoc extension, which is not installed.'
    })
  })

  it('shows a distinct timed-out toast for a client-side TimeoutError, telling the reader not to blindly retry', async () => {
    await mountDialog()
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw new TimeoutError({ method: 'POST', url: '/_api/sites/site-1/pages/import' })
    })

    await selectFile(new File(['hello'], 'notes.docx', { type: 'application/octet-stream' }))
    await body().find('.import-convert-btn').trigger('click')
    await flushPromises()

    expect(body().find('pre').exists()).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'pages.import.convertTimedOut',
      caption: 'pages.import.convertTimedOutHint'
    })
  })

  describe('Pandoc availability (OpenProject #1209)', () => {
    it('grays out Pandoc-only formats and shows an install hint when Pandoc is not installed', async () => {
      await mountDialog({}, { pandocInstalled: false })
      await selectFile(new File(['hello'], 'notes.docx', { type: 'application/octet-stream' }))

      await body().find('[role="combobox"]').trigger('click')
      const docxOption = body()
        .findAll('[role="option"]')
        .find((el) => el.text().includes('Word Document'))
      expect(docxOption.attributes('aria-disabled')).toBe('true')
      expect(body().text()).toContain('pages.import.pandocMissing')
    })

    it('leaves Convert disabled for a Pandoc-only format while Pandoc is missing', async () => {
      await mountDialog({}, { pandocInstalled: false })
      await selectFile(new File(['hello'], 'notes.docx', { type: 'application/octet-stream' }))

      expect(body().find('.import-convert-btn').attributes('disabled')).toBeDefined()
    })

    it('still allows markdown, which needs no Pandoc, when Pandoc is missing', async () => {
      await mountDialog({}, { pandocInstalled: false })
      await selectFile(new File(['# Hi'], 'notes.md', { type: 'text/markdown' }))

      expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
    })

    it('does not gray out any format, and shows no hint, once Pandoc is installed', async () => {
      await mountDialog({}, { pandocInstalled: true })
      await selectFile(new File(['hello'], 'notes.docx', { type: 'application/octet-stream' }))

      expect(body().find('.import-convert-btn').attributes('disabled')).toBeUndefined()
      expect(body().text()).not.toContain('pages.import.pandocMissing')
    })
  })
})
