import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { queue } from '@/composables/notify'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'

const EMPTY_BODY = '{"v":2,"w":800,"h":450}'
const EMPTY_BOARD_MARKDOWN = '::block-whiteboard\n```whiteboard\n' + EMPTY_BODY + '\n```\n::'

const beginStroke = vi.fn(() => true)

class StubWhiteboard extends HTMLElement {
  get updateComplete() {
    return Promise.resolve(true)
  }

  beginStroke(event) {
    return beginStroke(event)
  }
}

function boardBody(strokeCount) {
  const s = []
  for (let i = 0; i < strokeCount; i++) {
    s.push({ c: '#000000', z: 4, p: [i, i, 50, i + 1, i + 1, 60] })
  }
  return [EMPTY_BODY, ...s.map((stroke) => JSON.stringify(stroke))].join('\n')
}

function boardMarkdown(body) {
  return '::block-whiteboard\n```whiteboard\n' + body + '\n```\n::'
}

async function mountEditor(initialContent) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  useSiteStore()

  const wrapper = mount(EditorWysiwyg, {
    attachTo: document.body,
    global: { plugins: [createTestI18n()] }
  })
  await nextTick()
  await nextTick()
  return { wrapper, pageStore, editor: wrapper.vm.editor }
}

function whiteboardNodes(editor) {
  const nodes = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'wikiBlock' && node.attrs.block === 'whiteboard') {
      nodes.push(node)
    }
  })
  return nodes
}

function bodyOf(node) {
  return node.firstChild?.textContent
}

function findMenuItem(wrapper, key) {
  return wrapper.vm.menuBar.find((item) => item.key === key)
}

function pointerDown(target, pointerType, init = {}) {
  const event = new PointerEvent('pointerdown', {
    pointerType,
    pointerId: 7,
    button: 0,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

function keyDown(target, init) {
  const event = new KeyboardEvent('keydown', {
    code: 'KeyP',
    bubbles: true,
    cancelable: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

function whiteboardChange(target, body) {
  target.dispatchEvent(
    new CustomEvent('whiteboard-change', { bubbles: true, composed: true, detail: { body } })
  )
}

function stubPlatform(platform) {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

let mounted = null

beforeAll(() => {
  if (!customElements.get('block-whiteboard')) {
    customElements.define('block-whiteboard', StubWhiteboard)
  }
})

beforeEach(() => {
  queue.splice(0, queue.length)
  beginStroke.mockClear()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  delete navigator.platform
})

describe('EditorWysiwyg ink insertion: Draw toolbar button', () => {
  it('inserts an empty block-whiteboard at the cursor', async () => {
    const { wrapper, editor, pageStore } = await mountEditor('Before\n\nAfter')
    mounted = wrapper
    editor.commands.setTextSelection(7)

    findMenuItem(wrapper, 'draw').action()
    await nextTick()

    expect(whiteboardNodes(editor)).toHaveLength(1)
    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(EMPTY_BODY)
    expect(pageStore.content).toBe('Before\n\n' + EMPTY_BOARD_MARKDOWN + '\n\nAfter')
    expect(wrapper.find('block-whiteboard').exists()).toBe(true)
  })

  it('carries a translated title and the scribble glyph', async () => {
    const { wrapper } = await mountEditor('')
    mounted = wrapper
    const draw = findMenuItem(wrapper, 'draw')
    expect(draw.title).toBe('editor.wysiwyg.draw')
    expect(draw.icon).toBe('tabler:scribble')
  })

  it('leaves the cursor after the board rather than inside its JSON body', async () => {
    const { wrapper, editor } = await mountEditor('')
    mounted = wrapper

    findMenuItem(wrapper, 'draw').action()
    await nextTick()

    const { $from } = editor.state.selection
    expect($from.parent.type.name).toBe('paragraph')
    for (let depth = $from.depth; depth > 0; depth--) {
      expect($from.node(depth).type.name).not.toBe('wikiBlock')
    }
  })

  it('round-trips the inserted board through the saved markdown', async () => {
    const { wrapper, pageStore } = await mountEditor('')
    mounted = wrapper
    findMenuItem(wrapper, 'draw').action()
    await nextTick()
    const saved = pageStore.content
    wrapper.unmount()

    const reloaded = await mountEditor(saved)
    mounted = reloaded.wrapper
    expect(whiteboardNodes(reloaded.editor)).toHaveLength(1)
    expect(bodyOf(whiteboardNodes(reloaded.editor)[0])).toBe(EMPTY_BODY)
    expect(reloaded.editor.getMarkdown()).toBe(saved)
  })
})

describe('EditorWysiwyg ink insertion: Mod+Alt+P', () => {
  it('inserts a board on Cmd+Option+P on macOS, matching the physical key, not the π it types', async () => {
    stubPlatform('MacIntel')
    const { wrapper, editor } = await mountEditor('Text')
    mounted = wrapper

    const event = keyDown(editor.view.dom, { key: 'π', altKey: true, metaKey: true })
    await nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(whiteboardNodes(editor)).toHaveLength(1)
  })

  it('inserts a board on Ctrl+Alt+P elsewhere', async () => {
    stubPlatform('Win32')
    const { wrapper, editor } = await mountEditor('Text')
    mounted = wrapper

    keyDown(editor.view.dom, { key: 'p', altKey: true, ctrlKey: true })
    await nextTick()

    expect(whiteboardNodes(editor)).toHaveLength(1)
  })

  it.each([
    ['Alt+P alone', { key: 'π', altKey: true }],
    ['Mod+P without Alt', { key: 'p', metaKey: true }],
    ['Mod+Shift+Alt+P', { key: 'P', altKey: true, metaKey: true, shiftKey: true }],
    ['Ctrl+Alt+P on macOS', { key: 'p', altKey: true, ctrlKey: true }],
    ['Mod+Alt+O', { code: 'KeyO', key: 'ø', altKey: true, metaKey: true }]
  ])('ignores %s', async (_label, init) => {
    stubPlatform('MacIntel')
    const { wrapper, editor } = await mountEditor('Text')
    mounted = wrapper

    const event = keyDown(editor.view.dom, init)
    await nextTick()

    expect(event.defaultPrevented).toBe(false)
    expect(whiteboardNodes(editor)).toHaveLength(0)
  })
})

describe('EditorWysiwyg ink insertion: stylus auto-insert', () => {
  it('inserts a board below the line the pen lands on and passes the stroke through', async () => {
    const { wrapper, editor } = await mountEditor('First line\n\nSecond')
    mounted = wrapper
    const first = editor.view.dom.querySelector('p')

    const event = pointerDown(first, 'pen')
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(whiteboardNodes(editor)).toHaveLength(1)
    expect(editor.getMarkdown()).toBe('First line\n\n' + EMPTY_BOARD_MARKDOWN + '\n\nSecond')
    expect(beginStroke).toHaveBeenCalledTimes(1)
    expect(beginStroke).toHaveBeenCalledWith(event)
  })

  it('replaces an empty line the pen lands on rather than splitting text', async () => {
    const { wrapper, editor } = await mountEditor('First')
    mounted = wrapper
    editor.commands.setContent(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
          { type: 'paragraph' },
          { type: 'paragraph', content: [{ type: 'text', text: 'Last' }] }
        ]
      },
      { emitUpdate: false }
    )
    const empty = editor.view.dom.querySelectorAll('p')[1]

    pointerDown(empty, 'pen')
    await settle()

    expect(editor.state.doc.childCount).toBe(3)
    expect(editor.getMarkdown()).toBe('First\n\n' + EMPTY_BOARD_MARKDOWN + '\n\nLast')
  })

  it('refuses a pen insertion once the page is at its combined drawing cap', async () => {
    const { wrapper, editor } = await mountEditor('First')
    mounted = wrapper
    const bigBody = JSON.stringify({ v: 2, w: 800, h: 450, pad: 'x'.repeat(262110) })
    const board = {
      type: 'wikiBlock',
      attrs: { block: 'whiteboard', props: {} },
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'whiteboard' },
          content: [{ type: 'text', text: bigBody }]
        }
      ]
    }
    editor.commands.setContent(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
          board,
          board,
          board,
          board
        ]
      },
      { emitUpdate: false }
    )

    const event = pointerDown(editor.view.dom.querySelector('p'), 'pen')
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(whiteboardNodes(editor)).toHaveLength(4)
    expect(beginStroke).not.toHaveBeenCalled()
    expect(queue.map((n) => n.message)).toContain('editor.whiteboard.pageFull')
  })

  it.each(['mouse', 'touch'])('never auto-inserts for %s input', async (pointerType) => {
    const { wrapper, editor, pageStore } = await mountEditor('First\n\nSecond')
    mounted = wrapper
    const before = pageStore.content

    const event = pointerDown(editor.view.dom.querySelector('p'), pointerType)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(whiteboardNodes(editor)).toHaveLength(0)
    expect(pageStore.content).toBe(before)
    expect(beginStroke).not.toHaveBeenCalled()
  })

  it('ignores the pen barrel button and eraser', async () => {
    const { wrapper, editor } = await mountEditor('First')
    mounted = wrapper

    pointerDown(editor.view.dom.querySelector('p'), 'pen', { button: 2 })
    pointerDown(editor.view.dom.querySelector('p'), 'pen', { button: 5 })
    await settle()

    expect(whiteboardNodes(editor)).toHaveLength(0)
  })

  it('does not insert a second board when the pen lands on an existing one', async () => {
    const { wrapper, editor } = await mountEditor('Intro\n\n' + EMPTY_BOARD_MARKDOWN)
    mounted = wrapper
    const board = editor.view.dom.querySelector('block-whiteboard')

    pointerDown(board, 'pen')
    pointerDown(board.querySelector('pre') ?? board, 'pen')
    await settle()

    expect(whiteboardNodes(editor)).toHaveLength(1)
    expect(beginStroke).not.toHaveBeenCalled()
  })

  it('does nothing while the editor is read-only', async () => {
    const { wrapper, editor } = await mountEditor('First')
    mounted = wrapper
    editor.setEditable(false)

    pointerDown(editor.view.dom.querySelector('p'), 'pen')
    await settle()

    expect(whiteboardNodes(editor)).toHaveLength(0)
  })

  it('does not start a stroke when the pen has lifted before the element was ready', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const whenDefined = vi.spyOn(customElements, 'whenDefined').mockReturnValue(pending)
    try {
      const { wrapper, editor } = await mountEditor('First')
      mounted = wrapper

      pointerDown(editor.view.dom.querySelector('p'), 'pen')
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen' }))
      release()
      await settle()

      expect(whiteboardNodes(editor)).toHaveLength(1)
      expect(beginStroke).not.toHaveBeenCalled()
    } finally {
      whenDefined.mockRestore()
    }
  })
})

describe('EditorWysiwyg ink insertion: whiteboard-change write-back', () => {
  it('replaces the board body, one undo step per stroke', async () => {
    const { wrapper, editor, pageStore } = await mountEditor(boardMarkdown(EMPTY_BODY))
    mounted = wrapper
    const board = editor.view.dom.querySelector('block-whiteboard')

    whiteboardChange(board, boardBody(1))
    await nextTick()
    whiteboardChange(board, boardBody(2))
    await nextTick()

    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(boardBody(2))
    expect(pageStore.content.trimEnd()).toBe(boardMarkdown(boardBody(2)))

    editor.commands.undo()
    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(boardBody(1))
    editor.commands.undo()
    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(EMPTY_BODY)
  })

  it('writes back to the board the event came from, not its neighbour', async () => {
    const { wrapper, editor } = await mountEditor(
      boardMarkdown(EMPTY_BODY) + '\n\nBetween\n\n' + boardMarkdown(EMPTY_BODY)
    )
    mounted = wrapper
    const boards = editor.view.dom.querySelectorAll('block-whiteboard')

    whiteboardChange(boards[1], boardBody(3))
    await nextTick()

    const nodes = whiteboardNodes(editor)
    expect(bodyOf(nodes[0])).toBe(EMPTY_BODY)
    expect(bodyOf(nodes[1])).toBe(boardBody(3))
  })

  it.each([
    ['too many strokes', () => boardBody(2001)],
    [
      'too many points',
      () =>
        EMPTY_BODY +
        '\n' +
        JSON.stringify({ c: '#000', z: 1, p: Array.from({ length: 150003 }, () => 0) })
    ],
    ['too many bytes', () => JSON.stringify({ v: 2, w: 800, h: 450, pad: 'x'.repeat(262144) })]
  ])('refuses a body with %s and keeps the last accepted one', async (_label, makeBody) => {
    const { wrapper, editor, pageStore } = await mountEditor(boardMarkdown(boardBody(1)))
    mounted = wrapper
    const before = pageStore.content

    whiteboardChange(editor.view.dom.querySelector('block-whiteboard'), makeBody())
    await nextTick()

    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(boardBody(1))
    expect(pageStore.content).toBe(before)
    expect(queue.map((n) => n.message)).toContain('editor.whiteboard.blockTooLarge')
  })

  it('refuses an unparseable body', async () => {
    const { wrapper, editor } = await mountEditor(boardMarkdown(EMPTY_BODY))
    mounted = wrapper

    whiteboardChange(editor.view.dom.querySelector('block-whiteboard'), '{"v":2,')
    await nextTick()

    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(EMPTY_BODY)
    expect(queue.map((n) => n.message)).toContain('editor.whiteboard.invalidBody')
  })
})

describe('EditorWysiwyg ink insertion: page-wide cap and highlighting', () => {
  function paddedBody(padLength) {
    return JSON.stringify({ v: 2, w: 800, h: 450, pad: 'x'.repeat(padLength) })
  }

  function setBoards(editor, bodies) {
    editor.commands.setContent(
      {
        type: 'doc',
        content: bodies.map((body) => ({
          type: 'wikiBlock',
          attrs: { block: 'whiteboard', props: {} },
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'whiteboard' },
              content: [{ type: 'text', text: body }]
            }
          ]
        }))
      },
      { emitUpdate: false }
    )
  }

  it('refuses a stroke that would push the page past 1 MiB of drawings, and accepts a shrink', async () => {
    const { wrapper, editor } = await mountEditor('')
    mounted = wrapper
    const body = paddedBody(209000)
    setBoards(editor, [body, body, body, body, body])
    const first = editor.view.dom.querySelector('block-whiteboard')

    whiteboardChange(first, paddedBody(213000))
    await nextTick()
    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(body)
    expect(queue.map((n) => n.message)).toContain('editor.whiteboard.pageTooLarge')

    whiteboardChange(first, paddedBody(208000))
    await nextTick()
    expect(bodyOf(whiteboardNodes(editor)[0])).toBe(paddedBody(208000))
  })

  it('does not syntax-highlight a board body as guessed-language code', async () => {
    const { wrapper, editor } = await mountEditor(boardMarkdown(boardBody(3)))
    mounted = wrapper

    const pre = editor.view.dom.querySelector('block-whiteboard pre')
    expect(pre).not.toBeNull()
    expect(pre.querySelector('[class*="hljs-"]')).toBeNull()
  })
})
