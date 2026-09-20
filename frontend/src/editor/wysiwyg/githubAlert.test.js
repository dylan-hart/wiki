import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

import { GithubAlert } from './githubAlert.js'

function buildEditor(content) {
  return new Editor({
    content,
    contentType: 'markdown',
    extensions: [StarterKit.configure({ blockquote: false }), Markdown, GithubAlert]
  })
}

function findFirst(editor, typeName) {
  let found = null
  editor.state.doc.descendants((node) => {
    if (!found && node.type.name === typeName) {
      found = node
    }
  })
  return found
}

describe('GithubAlert', () => {
  it('parses a bare marker (no title) into a blockquote node carrying alert attrs', () => {
    const editor = buildEditor('> [!NOTE]\n> Body text here.')
    const alert = findFirst(editor, 'blockquote')
    expect(alert).not.toBeNull()
    expect(alert.attrs).toEqual({ kind: 'note', title: '' })
    expect(alert.textContent).toBe('Body text here.')
    editor.destroy()
  })

  it('parses a marker with a title', () => {
    const editor = buildEditor('> [!WARNING] Read this first\n> Body text.')
    const alert = findFirst(editor, 'blockquote')
    expect(alert.attrs).toEqual({ kind: 'warning', title: 'Read this first' })
    editor.destroy()
  })

  it('leaves a plain blockquote with no alert attrs when there is no marker', () => {
    const editor = buildEditor('> Just a regular quote.')
    const quote = findFirst(editor, 'blockquote')
    expect(quote).not.toBeNull()
    expect(quote.attrs.kind).toBeNull()
    editor.destroy()
  })

  it('round-trips a bare marker back to markdown', () => {
    const authored = '> [!NOTE]\n>\n> Body text here.'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('round-trips a marker with a title back to markdown', () => {
    const authored = '> [!WARNING] Read this first\n>\n> Body text.'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('round-trips a plain blockquote unchanged', () => {
    const authored = '> Just a regular quote.'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('parses a marker with no body at all (blockquote content stays valid)', () => {
    const editor = buildEditor('> [!NOTE]')
    const alert = findFirst(editor, 'blockquote')
    expect(alert).not.toBeNull()
    expect(alert.attrs).toEqual({ kind: 'note', title: '' })
    expect(editor.getMarkdown()).toBe('> [!NOTE]')
    editor.destroy()
  })

  it('reloads a saved alert document identically (save -> reload -> save)', () => {
    const editor = buildEditor('> [!CAUTION] Heads up\n> This could break things.')
    const saved = editor.getMarkdown()
    editor.destroy()

    const reloaded = buildEditor(saved)
    expect(reloaded.getMarkdown()).toBe(saved)
    reloaded.destroy()
  })
})
