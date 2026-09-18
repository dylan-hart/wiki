import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

import { IconShortcode } from './iconShortcode.js'

function buildEditor(content) {
  return new Editor({
    content,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, IconShortcode]
  })
}

describe('IconShortcode', () => {
  it('parses an icon shortcode into an iconShortcode node', () => {
    const editor = buildEditor('Click :tabler:home: to go back.')
    let found = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'iconShortcode') {
        found = node
      }
    })
    expect(found).not.toBeNull()
    expect(found.attrs).toEqual({ icon: 'tabler:home' })
    editor.destroy()
  })

  it('round-trips an icon shortcode back to markdown', () => {
    const authored = 'Click :tabler:home: to go back.'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('handles multiple icon shortcodes on the same line', () => {
    const authored = ':mdi:account-edit: and :tabler:arrows-vertical: both here.'
    const editor = buildEditor(authored)
    const found = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'iconShortcode') {
        found.push(node.attrs.icon)
      }
    })
    expect(found).toEqual(['mdi:account-edit', 'tabler:arrows-vertical'])
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('reloads a saved document identically (save -> reload -> save)', () => {
    const editor = buildEditor('Some text with :la:plus: an icon.')
    const saved = editor.getMarkdown()
    editor.destroy()

    const reloaded = buildEditor(saved)
    expect(reloaded.getMarkdown()).toBe(saved)
    reloaded.destroy()
  })
})
