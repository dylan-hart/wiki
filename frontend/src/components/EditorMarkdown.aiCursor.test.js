import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { AI_CURSOR_PRECONDITION } from '@/composables/aiAssistCursorActions'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { editorState, fakeEditor, mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

function addTrackingToModel(model) {
  const decorations = new Map()
  let seq = 0
  model.getValueInRange = ({ startLineNumber, startColumn, endLineNumber, endColumn }) => {
    const lines = model
      .getValue()
      .split('\n')
      .slice(startLineNumber - 1, endLineNumber)
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, endColumn - 1)
    lines[0] = lines[0].slice(startColumn - 1)
    return lines.join('\n')
  }
  model.deltaDecorations = (oldIds, added) => {
    for (const id of oldIds) decorations.delete(id)
    return added.map((decoration) => {
      const id = `d${++seq}`
      decorations.set(id, { ...decoration.range })
      return id
    })
  }
  model.getDecorationRange = (id) => decorations.get(id) ?? null
  model.isDisposed = () => false
}

async function mountEditor(content, cursor) {
  const mounted = await mountEditorMarkdown(EditorMarkdown, content)
  useSiteStore().id = 'site-1'
  addTrackingToModel(editorState.fakeModel)
  editorState.cursorPosition = cursor
  fakeEditor.pushUndoStop = vi.fn()
  return mounted
}

async function runAndAnswer(actionId, prompt) {
  const running = editorState.registeredActions[actionId].run(fakeEditor)
  await flushPromises()
  const opened = openDialogs[openDialogs.length - 1]
  closeDialog(opened.id, true, { prompt })
  await running
  await flushPromises()
  return opened
}

describe('EditorMarkdown AI cursor actions', () => {
  let wrapper = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    openDialogs.splice(0, openDialogs.length)
    notifyQueue.splice(0, notifyQueue.length)
  })

  it('registers Expand and Generate, hidden while the AI gate refuses or text is selected', async () => {
    ;({ wrapper } = await mountEditor('Hello', { lineNumber: 1, column: 6 }))

    for (const id of ['cardinal.ai.expand', 'cardinal.ai.generate']) {
      const action = editorState.registeredActions[id]
      expect(action).toBeDefined()
      expect(action.contextMenuGroupId).toBeTruthy()
      expect(action.precondition).toBe(AI_CURSOR_PRECONDITION)
    }
    expect(AI_CURSOR_PRECONDITION).toMatch(/(^|&&\s*)cardinalAiAssist(\s*&&|$)/)
    expect(AI_CURSOR_PRECONDITION).toContain('!editorHasSelection')
  })

  it('Generate posts the prompt with the page context and inserts the answer at the cursor', async () => {
    ;({ wrapper } = await mountEditor('Intro\nEnd', { lineNumber: 1, column: 6 }))
    const pageStore = usePageStore()
    pageStore.id = 'page-1'
    pageStore.path = 'docs/start'
    pageStore.locale = 'en'
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: ' and more' }) })

    const opened = await runAndAnswer('cardinal.ai.generate', 'Continue')

    expect(opened.props).toEqual({ action: 'generate', required: true })
    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/ai/generate', {
      json: {
        action: 'generate',
        text: 'Intro',
        prompt: 'Continue',
        pageId: 'page-1',
        path: 'docs/start',
        locale: 'en'
      }
    })
    expect(editorState.fakeModel.getValue()).toBe('Intro and more\nEnd')
    expect(fakeEditor.pushUndoStop).toHaveBeenCalledTimes(2)
  })

  it('Expand sends no prompt when none was given', async () => {
    ;({ wrapper } = await mountEditor('Some text', { lineNumber: 1, column: 10 }))
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: '!' }) })

    const opened = await runAndAnswer('cardinal.ai.expand', '')

    expect(opened.props).toEqual({ action: 'expand', required: false })
    const body = API_CLIENT.post.mock.calls[0][1].json
    expect(body.action).toBe('expand')
    expect(body.text).toBe('Some text')
    expect(body).not.toHaveProperty('prompt')
    expect(editorState.fakeModel.getValue()).toBe('Some text!')
  })

  it('shows the server refusal and leaves the document alone', async () => {
    ;({ wrapper } = await mountEditor('Text', { lineNumber: 1, column: 5 }))
    const refusal = Object.assign(new Error('Request failed with status code 429'), {
      data: { message: 'You have used your AI requests for today.' }
    })
    API_CLIENT.post.mockImplementationOnce(() => {
      throw refusal
    })

    await runAndAnswer('cardinal.ai.generate', 'Anything')

    expect(editorState.fakeModel.getValue()).toBe('Text')
    expect(notifyQueue.some((n) => n.caption === 'You have used your AI requests for today.')).toBe(
      true
    )
  })
})
