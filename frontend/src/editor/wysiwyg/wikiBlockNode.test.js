import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

import { WikiBlock, isOpaqueWikiBlock } from './wikiBlockNode'

function createEditor(content) {
  return new Editor({ content, extensions: [StarterKit, WikiBlock] })
}

describe('WikiBlock node', () => {
  it('defaults to no block and no props', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'wikiBlock' }] })
    const node = editor.state.doc.firstChild
    expect(node.attrs).toEqual({ block: null, props: {} })
    editor.destroy()
  })

  it('serialises to the real element tag, with its props as real HTML attributes', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'wikiBlock', attrs: { block: 'countdown', props: { date: '2030-01-01' } } }]
    })
    expect(editor.getHTML()).toContain('<block-countdown date="2030-01-01">')
    editor.destroy()
  })

  it('renders a bare (`true`) prop as a valueless HTML attribute', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'wikiBlock', attrs: { block: 'pdf', props: { 'hide-toolbar': true } } }]
    })
    expect(editor.getHTML()).toContain('<block-pdf hide-toolbar="">')
    editor.destroy()
  })

  it('nests a wikiBlock inside another, e.g. a tab inside a tabset', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'wikiBlock',
          attrs: { block: 'tabs', props: {} },
          content: [
            {
              type: 'wikiBlock',
              attrs: { block: 'tab', props: { label: 'One' } },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Content' }] }]
            }
          ]
        }
      ]
    })
    const html = editor.getHTML()
    expect(html).toContain('<block-tabs>')
    expect(html).toContain('<block-tab label="One">')
    expect(html).toContain('Content')
    editor.destroy()
  })
})

describe('WikiBlock: Backspace and Delete beside a block whose body is not shown', () => {
  const BODY = '{"v":2,"w":800,"h":450}'
  const paragraph = (text) => ({
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : undefined
  })
  const board = {
    type: 'wikiBlock',
    attrs: { block: 'whiteboard', props: {} },
    content: [
      {
        type: 'codeBlock',
        attrs: { language: 'whiteboard' },
        content: [{ type: 'text', text: BODY }]
      }
    ]
  }
  const spoiler = {
    type: 'wikiBlock',
    attrs: { block: 'spoiler', props: {} },
    content: [paragraph('inside')]
  }

  // -> No trailing paragraph, so each document below is exactly the one written out.
  function editorAt(content, paragraphIndex, where) {
    const editor = new Editor({
      content: { type: 'doc', content },
      extensions: [StarterKit.configure({ trailingNode: false }), WikiBlock]
    })
    const found = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') {
        found.push(where === 'end' ? pos + 1 + node.content.size : pos + 1)
      }
    })
    editor.commands.setTextSelection(found[paragraphIndex])
    return editor
  }

  // -> Through the view's own key handling, as a real key press goes: the `keyboardShortcut`
  //    command keeps only a handler's steps and drops the selection it set.
  function press(editor, key) {
    return editor.view.someProp('handleKeyDown', (handle) =>
      handle(editor.view, new KeyboardEvent('keydown', { key }))
    )
  }

  function shape(editor) {
    const parts = []
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'wikiBlock') {
        const children = []
        node.forEach((child) => children.push(child.type.name))
        parts.push(`${node.attrs.block}(${children.join(',')})`)
      } else {
        parts.push(`${node.type.name}:${node.textContent}`)
      }
    })
    return parts
  }

  const selectedBlock = (editor) => editor.state.selection.node?.attrs.block

  it('reads a fenced body, or none at all, as not shown', () => {
    const editor = createEditor({
      type: 'doc',
      content: [board, spoiler, { type: 'wikiBlock', attrs: { block: 'youtube', props: {} } }]
    })
    const { doc } = editor.state
    expect(isOpaqueWikiBlock(doc.child(0))).toBe(true)
    expect(isOpaqueWikiBlock(doc.child(1))).toBe(false)
    expect(isOpaqueWikiBlock(doc.child(2))).toBe(true)
    expect(isOpaqueWikiBlock(doc.child(0).firstChild)).toBe(false)
    editor.destroy()
  })

  it('selects the board on Backspace at the start of the line below it, keeping the line', () => {
    const editor = editorAt([board, paragraph('below')], 0, 'start')

    press(editor, 'Backspace')

    expect(shape(editor)).toEqual(['whiteboard(codeBlock)', 'paragraph:below'])
    expect(selectedBlock(editor)).toBe('whiteboard')
    editor.destroy()
  })

  it('selects the board on Delete at the end of the line above it, keeping the fence inside', () => {
    const editor = editorAt([paragraph('above'), board], 0, 'end')

    press(editor, 'Delete')

    expect(shape(editor)).toEqual(['paragraph:above', 'whiteboard(codeBlock)'])
    expect(selectedBlock(editor)).toBe('whiteboard')
    editor.destroy()
  })

  it('removes an empty line beside the board and selects the board', () => {
    const below = editorAt([paragraph('a'), board, paragraph()], 1, 'start')
    press(below, 'Backspace')
    expect(shape(below)).toEqual(['paragraph:a', 'whiteboard(codeBlock)'])
    expect(selectedBlock(below)).toBe('whiteboard')
    below.destroy()

    const above = editorAt([paragraph('a'), paragraph(), board], 1, 'start')
    press(above, 'Delete')
    expect(shape(above)).toEqual(['paragraph:a', 'whiteboard(codeBlock)'])
    expect(selectedBlock(above)).toBe('whiteboard')
    above.destroy()
  })

  it('leaves Backspace inside a line, and beside a block showing its children, as they were', () => {
    // -> Not handled at all, so the browser deletes the character itself.
    const inside = editorAt([board, paragraph('below')], 0, 'end')
    expect(press(inside, 'Backspace')).toBeFalsy()
    expect(shape(inside)).toEqual(['whiteboard(codeBlock)', 'paragraph:below'])
    inside.destroy()

    const container = editorAt([spoiler, paragraph('below')], 1, 'start')
    press(container, 'Backspace')
    expect(shape(container)).toEqual(['spoiler(paragraph,paragraph)'])
    expect(container.state.doc.firstChild.textContent).toBe('insidebelow')
    container.destroy()
  })

  it('still lets Enter on an empty last line leave a container block', () => {
    const editor = editorAt(
      [{ ...spoiler, content: [paragraph('inside'), paragraph()] }],
      1,
      'start'
    )

    press(editor, 'Enter')

    expect(shape(editor)).toEqual(['spoiler(paragraph)', 'paragraph:'])
    editor.destroy()
  })
})
