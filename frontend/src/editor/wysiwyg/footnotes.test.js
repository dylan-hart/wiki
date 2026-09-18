import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

import { FootnoteReference, FootnoteDefinition } from './footnotes.js'

function buildEditor(content) {
  return new Editor({
    content,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, FootnoteReference, FootnoteDefinition]
  })
}

describe('Footnotes', () => {
  it('parses a reference into a footnoteReference node', () => {
    const editor = buildEditor('Body text[^1].\n\n[^1]: The note itself.')
    let ref = null
    let def = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'footnoteReference') {
        ref = node
      }
      if (node.type.name === 'footnoteDefinition') {
        def = node
      }
    })
    expect(ref).not.toBeNull()
    expect(ref.attrs).toEqual({ label: '1' })
    expect(def).not.toBeNull()
    expect(def.attrs).toEqual({ label: '1' })
    expect(def.textContent).toBe('The note itself.')
    editor.destroy()
  })

  it('round-trips a reference and its definition back to markdown', () => {
    const authored = 'Body text[^1].\n\n[^1]: The note itself.'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('supports named (non-numeric) labels', () => {
    const authored = 'See[^note-a] for details.\n\n[^note-a]: Extra context.'
    const editor = buildEditor(authored)
    let ref = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'footnoteReference') {
        ref = node
      }
    })
    expect(ref.attrs.label).toBe('note-a')
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('supports more than one footnote in the same document', () => {
    const authored = 'One[^1] and two[^2].\n\n[^1]: First note.\n\n[^2]: Second note.'
    const editor = buildEditor(authored)
    const labels = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'footnoteReference') {
        labels.push(node.attrs.label)
      }
    })
    expect(labels).toEqual(['1', '2'])
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('reloads a saved document identically (save -> reload -> save)', () => {
    const editor = buildEditor('Claim[^src].\n\n[^src]: Where this came from.')
    const saved = editor.getMarkdown()
    editor.destroy()

    const reloaded = buildEditor(saved)
    expect(reloaded.getMarkdown()).toBe(saved)
    reloaded.destroy()
  })
})
