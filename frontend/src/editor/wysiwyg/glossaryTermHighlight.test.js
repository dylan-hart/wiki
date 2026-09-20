import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

import { GlossaryTermHighlight, glossaryTermHighlightPluginKey } from './glossaryTermHighlight.js'

function buildEditor(content, terms) {
  return new Editor({
    content,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, GlossaryTermHighlight.configure({ terms })]
  })
}

function decoratedRanges(editor) {
  const decorationSet = glossaryTermHighlightPluginKey.getState(editor.view.state)
  return decorationSet.find().map((deco) => ({
    from: deco.from,
    to: deco.to,
    title: deco.type.attrs.title
  }))
}

describe('GlossaryTermHighlight', () => {
  const terms = [{ term: 'API', definition: 'Application Programming Interface', link: null }]

  it('decorates a case-insensitive whole-word match', () => {
    const editor = buildEditor('Call the api today.', terms)
    const decos = decoratedRanges(editor)
    expect(decos).toHaveLength(1)
    expect(decos[0].title).toBe('Application Programming Interface')
    expect(editor.state.doc.textBetween(decos[0].from, decos[0].to)).toBe('api')
    editor.destroy()
  })

  it('does not match a term as a substring of a longer word', () => {
    const editor = buildEditor('Please login to continue.', [
      { term: 'log', definition: 'A record of events.', link: null }
    ])
    expect(decoratedRanges(editor)).toHaveLength(0)
    editor.destroy()
  })

  it('still matches the term as its own word', () => {
    const editor = buildEditor('Check the log for errors.', [
      { term: 'log', definition: 'A record of events.', link: null }
    ])
    const decos = decoratedRanges(editor)
    expect(decos).toHaveLength(1)
    expect(editor.state.doc.textBetween(decos[0].from, decos[0].to)).toBe('log')
    editor.destroy()
  })

  it('never changes the document -- decorations are view-only', () => {
    const authored = 'Call the API today.'
    const editor = buildEditor(authored, terms)
    expect(editor.getMarkdown()).toBe(authored)
    expect(decoratedRanges(editor)).toHaveLength(1)
    editor.destroy()
  })

  it('produces no decorations with an empty term list', () => {
    const editor = buildEditor('Call the API today.', [])
    expect(decoratedRanges(editor)).toHaveLength(0)
    editor.destroy()
  })

  it('matches an alias to the same entry as its term', () => {
    const editor = buildEditor('The REST API is here.', [
      {
        term: 'API',
        definition: 'Application Programming Interface',
        aliases: [{ value: 'REST API' }],
        link: null
      }
    ])
    const decos = decoratedRanges(editor)
    // -> Longest-first: "REST API" (the alias) wins over the bare "API" it contains.
    expect(decos).toHaveLength(1)
    expect(editor.state.doc.textBetween(decos[0].from, decos[0].to)).toBe('REST API')
    editor.destroy()
  })
})
