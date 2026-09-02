import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { TimeoutError } from 'ky'

import { confirm } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

/*
  `monaco-editor` needs real browser layout/measurement APIs (`ResizeObserver`, text metrics, a
  genuine contenteditable surface) that this workspace's Vitest environment does not provide -- see
  `EditorCode.test.js`'s identical note, whose mocking pattern this reuses: `editor.create` returns
  one fake instance whose `getValue`/`setValue` a test can drive directly.
*/
const fakeEditor = {
  getValue: vi.fn(() => ''),
  setValue: vi.fn(),
  dispose: vi.fn()
}

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn((_el, opts) => {
      fakeEditor.getValue.mockReturnValue(opts.value)
      return fakeEditor
    })
  }
}))

const monaco = await import('monaco-editor')
const GlossaryImportDialog = (await import('./GlossaryImportDialog.vue')).default

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

beforeEach(() => {
  vi.clearAllMocks()
  notifyQueue.splice(0, notifyQueue.length)
})

function mountDialog(siteId = 'site-1') {
  const i18n = createTestI18n()
  currentWrapper = mount(GlossaryImportDialog, {
    props: { siteId },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

function jsonFile(name, contents) {
  return { name, type: 'application/json', text: () => Promise.resolve(contents) }
}

/**
 * Glossary JSON import (OpenProject #1114, review feedback #1207): a Monaco JSON editor that is
 * directly editable/pasteable and also accepts a dropped or browsed-for `.json` file, replacing the
 * old bare OS file picker. Submitting still confirms, then POSTs the whole-glossary replace to
 * `sites/:siteId/glossary/import` exactly like the flow it replaces.
 */
describe('GlossaryImportDialog: editor setup', () => {
  it('creates the Monaco instance in json language mode', () => {
    mountDialog()

    expect(monaco.editor.create).toHaveBeenCalledTimes(1)
    const [, opts] = monaco.editor.create.mock.calls[0]
    expect(opts.language).toBe('json')
  })

  it('disposes the editor on unmount', () => {
    const wrapper = mountDialog()

    wrapper.unmount()
    currentWrapper = null

    expect(fakeEditor.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('GlossaryImportDialog: loading a file', () => {
  it('loads a browsed .json file’s contents into the editor', async () => {
    const wrapper = mountDialog()
    const file = jsonFile('glossary.json', '{"terms":[]}')

    await wrapper.vm.onFileSelected({ target: { files: [file], value: 'x' } })

    expect(fakeEditor.setValue).toHaveBeenCalledWith('{"terms":[]}')
  })

  it('loads a dropped .json file’s contents into the editor', async () => {
    const wrapper = mountDialog()
    const file = jsonFile('glossary.json', '{"terms":[{"term":"X"}]}')

    await wrapper.vm.onDrop({ dataTransfer: { files: [file] } })

    expect(fakeEditor.setValue).toHaveBeenCalledWith('{"terms":[{"term":"X"}]}')
    expect(wrapper.vm.state.isDraggingOver).toBe(false)
  })

  it('rejects a non-json file rather than loading it', async () => {
    const wrapper = mountDialog()
    const file = { name: 'notes.txt', type: 'text/plain', text: () => Promise.resolve('hi') }

    await wrapper.vm.onFileSelected({ target: { files: [file], value: 'x' } })

    expect(fakeEditor.setValue).not.toHaveBeenCalled()
  })
})

describe('GlossaryImportDialog: submit()', () => {
  it('rejects text that is not valid JSON, without confirming', () => {
    const wrapper = mountDialog()
    fakeEditor.getValue.mockReturnValue('{not json')

    wrapper.vm.submit()

    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects valid JSON with no "terms" array, without confirming', () => {
    const wrapper = mountDialog()
    fakeEditor.getValue.mockReturnValue(JSON.stringify({ notTerms: [] }))

    wrapper.vm.submit()

    expect(confirm).not.toHaveBeenCalled()
  })

  it('confirms, then POSTs the parsed data to .../glossary/import and closes with ok', async () => {
    const wrapper = mountDialog()
    const payload = {
      formatVersion: 1,
      terms: [{ term: 'X', definition: 'Y', aliases: [], path: null }]
    }
    fakeEditor.getValue.mockReturnValue(JSON.stringify(payload))
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    wrapper.vm.submit()
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/glossary/import',
      // -> A named, work-sized timeout rather than ky's 10s default (OpenProject #1718)
      expect.objectContaining({ json: payload, timeout: expect.any(Number) })
    )
    expect(wrapper.emitted().ok).toBeTruthy()
  })

  it('notifies on failure without closing the dialog', async () => {
    const wrapper = mountDialog()
    fakeEditor.getValue.mockReturnValue(JSON.stringify({ terms: [] }))
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(new Error('network')) })

    wrapper.vm.submit()
    await flushPromises()

    expect(wrapper.emitted().ok).toBeFalsy()
    expect(wrapper.vm.state.importing).toBe(false)
  })

  it('shows a distinct timed-out toast for a client-side TimeoutError, telling the reader not to blindly retry', async () => {
    const wrapper = mountDialog()
    fakeEditor.getValue.mockReturnValue(JSON.stringify({ terms: [] }))
    API_CLIENT.post.mockImplementationOnce(() => {
      throw new TimeoutError({ method: 'POST', url: '/_api/sites/site-1/glossary/import' })
    })

    wrapper.vm.submit()
    await flushPromises()

    expect(wrapper.emitted().ok).toBeFalsy()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'admin.glossary.importTimedOut',
      caption: 'admin.glossary.importTimedOutHint'
    })
  })
})
