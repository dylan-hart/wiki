import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

/* The diff pane is real Monaco, which needs a layout engine this test has no reason to drag in. */
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createDiffEditor: vi.fn(() => ({
      setModel: vi.fn(),
      dispose: vi.fn()
    })),
    createModel: vi.fn((value) => ({ value, dispose: vi.fn() }))
  }
}))

import * as monaco from 'monaco-editor'

import PageSaveConflictDialog from './PageSaveConflictDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

const i18n = createTestI18n({
  editor: {
    collab: {
      saveConflict: {
        title: 'Save Conflict',
        message: '{authorName} saved a newer version of this page while you were editing it.',
        discard: 'Discard My Changes',
        saveAnyway: 'Save Anyway',
        serverVersion: 'Server version',
        yourVersion: 'Your changes'
      }
    }
  }
})

const SERVER_CONTENT = '# Title\n\nServer paragraph.'
const PENDING_CONTENT = '# Title\n\nMy pending paragraph.'

beforeEach(() => {
  document.body.innerHTML = ''
  monaco.editor.createDiffEditor.mockClear()
  monaco.editor.createModel.mockClear()
})

/*
  `<w-dialog>` teleports its content to `document.body`, so it never lands inside the wrapper's own
  root element: `wrapper.find()` cannot see it, and a native DOM query is used instead.
*/
describe('PageSaveConflictDialog', () => {
  it('emits ok with "discard" when the discard button is clicked', async () => {
    const wrapper = mount(PageSaveConflictDialog, {
      props: { authorName: 'Ada Lovelace' },
      global: { plugins: [i18n] }
    })
    await flushPromises()

    expect(document.body.textContent).toContain('Ada Lovelace')

    const buttons = [...document.body.querySelectorAll('button')]
    const discardBtn = buttons.find((b) => b.textContent === 'Discard My Changes')
    discardBtn.click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([['discard']])
  })

  it('emits ok with "overwrite" when the save-anyway button is clicked', async () => {
    const wrapper = mount(PageSaveConflictDialog, {
      props: { authorName: 'Ada Lovelace' },
      global: { plugins: [i18n] }
    })
    await flushPromises()

    const buttons = [...document.body.querySelectorAll('button')]
    const saveAnywayBtn = buttons.find((b) => b.textContent === 'Save Anyway')
    saveAnywayBtn.click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([['overwrite']])
  })

  it('mounts a Monaco diff of the server version against the pending content', async () => {
    mount(PageSaveConflictDialog, {
      props: {
        authorName: 'Ada Lovelace',
        serverContent: SERVER_CONTENT,
        pendingContent: PENDING_CONTENT
      },
      global: { plugins: [i18n] }
    })
    await flushPromises()

    expect(document.body.querySelector('.save-conflict-diff')).toBeTruthy()

    expect(monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1)
    const [container] = monaco.editor.createDiffEditor.mock.calls[0]
    expect(container).toBe(document.body.querySelector('.save-conflict-diff'))

    expect(monaco.editor.createModel).toHaveBeenCalledWith(SERVER_CONTENT, 'markdown')
    expect(monaco.editor.createModel).toHaveBeenCalledWith(PENDING_CONTENT, 'markdown')
  })
})
