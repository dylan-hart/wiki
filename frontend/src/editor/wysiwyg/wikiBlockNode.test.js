import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

import { WikiBlock } from './wikiBlockNode'

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
