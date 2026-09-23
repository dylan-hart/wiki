import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { queue } from '@/composables/notify'
import { useCommonStore } from '@/stores/common'

import { mountWithApp } from '../../test/mount.js'
import { editorState, fakeEditor } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const SITE_ID = 'site-1'
const STATUS_URL = `sites/${SITE_ID}/ai/status`
const GENERATE_URL = `sites/${SITE_ID}/ai/generate`
const REWRITE = 'cardinal.ai.rewriteSelection'
const SUMMARIZE = 'cardinal.ai.summarizeSelection'

function stubStatus(...answers) {
  const pending = [...answers]
  API_CLIENT.get.mockImplementation((url) => {
    if (url === STATUS_URL) {
      const answer = pending.length > 1 ? pending.shift() : pending[0]
      if (answer instanceof Error) {
        throw answer
      }
      return { json: () => Promise.resolve(answer) }
    }
    return { json: () => Promise.resolve(undefined) }
  })
}

function httpError(status) {
  const err = new Error(`Request failed with status code ${status}`)
  err.response = { status }
  err.data = { message: 'server text' }
  return err
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let nextSelections = []

function select(startLineNumber, startColumn, endLineNumber, endColumn) {
  nextSelections.push({
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn
  })
}

function generateCalls() {
  return API_CLIENT.post.mock.calls.filter(([url]) => url === GENERATE_URL)
}

function messages() {
  return queue.map((n) => n.message)
}

async function mountEditor(content) {
  const { wrapper, pageStore } = mountWithApp(EditorMarkdown, {
    stores: {
      page: { content, id: 'page-1', path: 'docs/intro', locale: 'en' },
      site: { id: SITE_ID }
    }
  })
  useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)
  await flushPromises()
  return { wrapper, pageStore }
}

const AVAILABLE = { available: true, reason: null, cap: 50, remaining: 10, retryAfter: null }
const CAPPED = { available: false, reason: 'cap', cap: 50, remaining: 0, retryAfter: 3600 }

describe('EditorMarkdown AI selection actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue.splice(0)
    nextSelections = []
    fakeEditor.getSelection.mockImplementation(
      () => nextSelections.shift() ?? fakeEditor.getSelections()[0]
    )
  })

  afterEach(() => {
    queue.splice(0)
  })

  it('registers Rewrite and Summarize in the context menu, gated on the AI key and a selection', async () => {
    stubStatus(AVAILABLE)
    await mountEditor('Hello world.')

    for (const id of [REWRITE, SUMMARIZE]) {
      const action = editorState.registeredActions[id]
      expect(action.contextMenuGroupId).toBeTruthy()
      expect(action.precondition).toBe('cardinalAiAssist && editorHasSelection')
    }
    expect(editorState.registeredActions[REWRITE].label).toBe('editor.ai.rewrite')
    expect(editorState.registeredActions[SUMMARIZE].label).toBe('editor.ai.summarize')
  })

  it('turns the context key on when the site reports the assistant available', async () => {
    stubStatus(AVAILABLE)
    await mountEditor('Hello world.')

    expect(API_CLIENT.get).toHaveBeenCalledWith(STATUS_URL)
    expect(editorState.contextKeys.cardinalAiAssist).toBe(true)
  })

  describe('while gated', () => {
    it.each([
      ['the flag is off', { available: false, reason: 'disabled' }],
      ['the daily cap is used up', CAPPED],
      ['the status route fails', httpError(404)]
    ])('keeps the actions hidden and sends nothing when %s', async (_label, status) => {
      stubStatus(status)
      await mountEditor('Hello world.')

      expect(editorState.contextKeys.cardinalAiAssist).toBe(false)

      select(1, 1, 1, 6)
      await editorState.registeredActions[REWRITE].run(fakeEditor)
      await flushPromises()

      expect(generateCalls()).toHaveLength(0)
      expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
      expect(editorState.fakeModel.getValue()).toBe('Hello world.')
    })
  })

  it('replaces the selection with the rewrite, as one undoable step', async () => {
    stubStatus(AVAILABLE)
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: 'Greetings' }) })
    await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    await editorState.registeredActions[REWRITE].run(fakeEditor)
    await flushPromises()

    expect(generateCalls()).toEqual([
      [
        GENERATE_URL,
        {
          json: {
            action: 'rewrite',
            text: 'Hello',
            pageId: 'page-1',
            path: 'docs/intro',
            locale: 'en'
          }
        }
      ]
    ])
    expect(editorState.fakeModel.getValue()).toBe('Greetings world.')

    const editOrder = fakeEditor.executeEdits.mock.invocationCallOrder[0]
    const stops = fakeEditor.pushUndoStop.mock.invocationCallOrder
    expect(fakeEditor.executeEdits.mock.calls[0][0]).toBe('ai')
    expect(stops.some((order) => order < editOrder)).toBe(true)
    expect(stops.some((order) => order > editOrder)).toBe(true)
  })

  it('summarizes a multi-line selection', async () => {
    stubStatus(AVAILABLE)
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: 'Short.' }) })
    await mountEditor('# Title\nFirst line.\nSecond line.\nAfter.')

    select(2, 1, 3, 13)
    await editorState.registeredActions[SUMMARIZE].run(fakeEditor)
    await flushPromises()

    expect(generateCalls()[0][1].json).toMatchObject({
      action: 'summarize',
      text: 'First line.\nSecond line.'
    })
    expect(editorState.fakeModel.getValue()).toBe('# Title\nShort.\nAfter.')
  })

  it('asks for a selection instead of sending an empty one', async () => {
    stubStatus(AVAILABLE)
    await mountEditor('Hello world.')

    select(1, 3, 1, 3)
    await editorState.registeredActions[REWRITE].run(fakeEditor)
    await flushPromises()

    expect(generateCalls()).toHaveLength(0)
    expect(messages()).toContain('editor.markup.noSelectionError')
  })

  it('refuses a selection over the length limit without sending it', async () => {
    stubStatus(AVAILABLE)
    const long = 'a'.repeat(20001)
    await mountEditor(long)

    select(1, 1, 1, long.length + 1)
    await editorState.registeredActions[REWRITE].run(fakeEditor)
    await flushPromises()

    expect(generateCalls()).toHaveLength(0)
    expect(messages()).toContain('editor.ai.errors.tooLong')
  })

  it('discards the result when the selected text changed while waiting', async () => {
    stubStatus(AVAILABLE)
    const pending = deferred()
    API_CLIENT.post.mockReturnValueOnce({ json: () => pending.promise })
    await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    const running = editorState.registeredActions[REWRITE].run(fakeEditor)
    editorState.fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      text: 'Howdy'
    })
    pending.resolve({ text: 'Greetings' })
    await running
    await flushPromises()

    expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
    expect(editorState.fakeModel.getValue()).toBe('Howdy world.')
    expect(messages()).toContain('editor.ai.selectionChanged')
  })

  it('runs one request at a time', async () => {
    stubStatus(AVAILABLE)
    const pending = deferred()
    API_CLIENT.post.mockReturnValueOnce({ json: () => pending.promise })
    await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    const first = editorState.registeredActions[REWRITE].run(fakeEditor)
    select(1, 7, 1, 12)
    await editorState.registeredActions[SUMMARIZE].run(fakeEditor)

    expect(generateCalls()).toHaveLength(1)
    expect(messages()).toContain('editor.ai.busy')

    pending.resolve({ text: 'Greetings' })
    await first
    await flushPromises()
    expect(editorState.fakeModel.getValue()).toBe('Greetings world.')
  })

  it('explains a refusal and hides the actions once the cap is reached', async () => {
    stubStatus(AVAILABLE, CAPPED)
    API_CLIENT.post.mockImplementationOnce(() => {
      throw httpError(429)
    })
    await mountEditor('Hello world.')
    expect(editorState.contextKeys.cardinalAiAssist).toBe(true)

    select(1, 1, 1, 6)
    await editorState.registeredActions[REWRITE].run(fakeEditor)
    await flushPromises()

    expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
    expect(editorState.fakeModel.getValue()).toBe('Hello world.')
    expect(messages()).toContain('editor.ai.errors.capReached')
    expect(editorState.contextKeys.cardinalAiAssist).toBe(false)
  })

  it('reports an empty answer rather than deleting the selection', async () => {
    stubStatus(AVAILABLE)
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: '' }) })
    await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    await editorState.registeredActions[REWRITE].run(fakeEditor)
    await flushPromises()

    expect(editorState.fakeModel.getValue()).toBe('Hello world.')
    expect(messages()).toContain('editor.ai.errors.empty')
  })

  it('drops the working toast once the request settles', async () => {
    stubStatus(AVAILABLE)
    const pending = deferred()
    API_CLIENT.post.mockReturnValueOnce({ json: () => pending.promise })
    await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    const running = editorState.registeredActions[REWRITE].run(fakeEditor)
    expect(messages()).toContain('editor.ai.working')

    pending.resolve({ text: 'Greetings' })
    await running
    expect(messages()).not.toContain('editor.ai.working')
  })

  it('applies nothing when the editor unmounts mid-request', async () => {
    stubStatus(AVAILABLE)
    const pending = deferred()
    API_CLIENT.post.mockReturnValueOnce({ json: () => pending.promise })
    const { wrapper } = await mountEditor('Hello world.')

    select(1, 1, 1, 6)
    const running = editorState.registeredActions[REWRITE].run(fakeEditor)
    wrapper.unmount()
    pending.resolve({ text: 'Greetings' })
    await running
    await flushPromises()

    expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
  })
})
