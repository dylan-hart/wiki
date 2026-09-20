import { describe, expect, it } from 'vitest'

import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Color } from '@tiptap/extension-color'
import FontFamily from '@tiptap/extension-font-family'
import Highlight from '@tiptap/extension-highlight'
import { Heading } from '@tiptap/extension-heading'
import { Paragraph } from '@tiptap/extension-paragraph'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'

import {
  extractTrailingBlockStyle,
  findStyleSpan,
  parseStyleAttr,
  serializeStyleAttr,
  withStyleSpanMarkdown,
  withStyleSpanRenderMarkdown,
  withTextAlignMarkdown
} from './wysiwygStyleAttrs'

/** Mirrors `EditorWysiwyg.vue#buildExtensions()`: a round-trip only holds for that exact set. */
function buildManager() {
  return new MarkdownManager({
    extensions: [
      StarterKit.configure({
        paragraph: false,
        heading: false,
        codeBlock: false,
        link: false,
        undoRedo: false
      }),
      withTextAlignMarkdown(Paragraph),
      withTextAlignMarkdown(Heading),
      Color,
      FontFamily,
      withStyleSpanRenderMarkdown(Highlight).configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      withStyleSpanMarkdown(TextStyle)
    ]
  })
}

function paragraphDoc(content) {
  return { type: 'doc', content: [{ type: 'paragraph', content }] }
}

function textNode(text, marks) {
  return marks ? { type: 'text', text, marks } : { type: 'text', text }
}

describe('parseStyleAttr / serializeStyleAttr', () => {
  it('parses a multi-declaration style value', () => {
    expect(parseStyleAttr('color: #D32F2F; font-family: monospace;')).toEqual({
      color: '#D32F2F',
      'font-family': 'monospace'
    })
  })

  it('tolerates a missing trailing semicolon and extra whitespace', () => {
    expect(parseStyleAttr('  color :  #D32F2F  ')).toEqual({ color: '#D32F2F' })
  })

  it('returns an empty object for empty/nullish input', () => {
    expect(parseStyleAttr('')).toEqual({})
    expect(parseStyleAttr(null)).toEqual({})
    expect(parseStyleAttr(undefined)).toEqual({})
  })

  it('serializes in the given property order, dropping falsy values', () => {
    expect(serializeStyleAttr({ color: '#D32F2F', 'font-family': null })).toBe('color: #D32F2F;')
    expect(serializeStyleAttr({ color: '#D32F2F', 'font-family': 'monospace' })).toBe(
      'color: #D32F2F; font-family: monospace;'
    )
  })

  it('round-trips through both functions', () => {
    const props = { color: '#D32F2F', 'font-family': 'monospace' }
    expect(parseStyleAttr(serializeStyleAttr(props))).toEqual(props)
  })
})

describe('findStyleSpan', () => {
  it('matches a simple span', () => {
    expect(findStyleSpan('[hello]{style="color: red;"} tail')).toEqual({
      inner: 'hello',
      styleText: 'color: red;',
      raw: '[hello]{style="color: red;"}'
    })
  })

  it('tracks nested bracket depth', () => {
    const span = findStyleSpan('[[hi]{style="background-color: yellow;"}]{style="color: red;"}')
    expect(span).toEqual({
      inner: '[hi]{style="background-color: yellow;"}',
      styleText: 'color: red;',
      raw: '[[hi]{style="background-color: yellow;"}]{style="color: red;"}'
    })
  })

  it('returns null when the source does not start with a bracket', () => {
    expect(findStyleSpan('hello')).toBeNull()
  })

  it('returns null when the bracket never closes', () => {
    expect(findStyleSpan('[hello')).toBeNull()
  })

  it('returns null when there is no trailing style attr', () => {
    expect(findStyleSpan('[hello](world)')).toBeNull()
    expect(findStyleSpan('[hello]{.class}')).toBeNull()
  })
})

describe('extractTrailingBlockStyle', () => {
  it('strips a trailing style attr off the last text token', () => {
    const tokens = [{ type: 'text', text: 'hello world {style="text-align: center;"}' }]
    const result = extractTrailingBlockStyle(tokens)
    expect(result.style).toBe('text-align: center;')
    expect(result.tokens).toEqual([{ type: 'text', text: 'hello world', raw: 'hello world' }])
  })

  it('drops the token entirely when nothing but the style attr remains', () => {
    const tokens = [{ type: 'text', text: '{style="text-align: center;"}' }]
    const result = extractTrailingBlockStyle(tokens)
    expect(result.style).toBe('text-align: center;')
    expect(result.tokens).toEqual([])
  })

  it('is a no-op when the last token is not text', () => {
    const tokens = [{ type: 'em', tokens: [] }]
    const result = extractTrailingBlockStyle(tokens)
    expect(result.style).toBeNull()
    expect(result.tokens).toBe(tokens)
  })

  it('is a no-op when there is no trailing style attr', () => {
    const tokens = [{ type: 'text', text: 'plain text' }]
    const result = extractTrailingBlockStyle(tokens)
    expect(result.style).toBeNull()
  })

  it('is a no-op on an empty/undefined token list', () => {
    expect(extractTrailingBlockStyle([])).toEqual({ tokens: [], style: null })
    expect(extractTrailingBlockStyle(undefined)).toEqual({ tokens: undefined, style: null })
  })
})

describe('text colour + font family round-trip (textStyle mark)', () => {
  it('serializes a coloured run as a style-attr bracket span', () => {
    const manager = buildManager()
    const doc = paragraphDoc([
      textNode('hello', [{ type: 'textStyle', attrs: { color: '#D32F2F' } }])
    ])
    expect(manager.serialize(doc)).toBe('[hello]{style="color: #D32F2F;"}')
  })

  it('parses that bracket span back into a textStyle mark with the same colour', () => {
    const manager = buildManager()
    const parsed = manager.parse('[hello]{style="color: #D32F2F;"}')
    const textNodeResult = parsed.content[0].content[0]
    expect(textNodeResult.text).toBe('hello')
    expect(textNodeResult.marks).toEqual([
      { type: 'textStyle', attrs: { color: '#D32F2F', fontFamily: null } }
    ])
  })

  it('combines colour and font-family from one mark occurrence into a single span', () => {
    const manager = buildManager()
    const doc = paragraphDoc([
      textNode('hello', [
        { type: 'textStyle', attrs: { color: '#D32F2F', fontFamily: 'monospace' } }
      ])
    ])
    const markdown = manager.serialize(doc)
    expect(markdown).toBe('[hello]{style="color: #D32F2F; font-family: monospace;"}')

    const parsed = manager.parse(markdown)
    const mark = parsed.content[0].content[0].marks[0]
    expect(mark.attrs.color).toBe('#D32F2F')
    expect(mark.attrs.fontFamily).toBe('monospace')
  })

  it('renders a font-only mark unwrapped when there is no colour', () => {
    const manager = buildManager()
    const doc = paragraphDoc([
      textNode('hello', [{ type: 'textStyle', attrs: { fontFamily: 'monospace' } }])
    ])
    expect(manager.serialize(doc)).toBe('[hello]{style="font-family: monospace;"}')
  })

  it('round-trips plain, unstyled text with no bracket span at all', () => {
    const manager = buildManager()
    const doc = paragraphDoc([textNode('hello')])
    const markdown = manager.serialize(doc)
    expect(markdown).toBe('hello')
    expect(manager.parse(markdown).content[0].content[0].marks).toBeUndefined()
  })
})

describe('highlight colour round-trip', () => {
  it('serializes a multicolor highlight as a style-attr bracket span', () => {
    const manager = buildManager()
    const doc = paragraphDoc([
      textNode('hello', [{ type: 'highlight', attrs: { color: '#FFF59D' } }])
    ])
    expect(manager.serialize(doc)).toBe('[hello]{style="background-color: #FFF59D;"}')
  })

  it('parses that bracket span back into a highlight mark with the same colour', () => {
    const manager = buildManager()
    const parsed = manager.parse('[hello]{style="background-color: #FFF59D;"}')
    const mark = parsed.content[0].content[0].marks[0]
    expect(mark).toEqual({ type: 'highlight', attrs: { color: '#FFF59D' } })
  })

  it('still renders a colourless highlight as plain ==text==', () => {
    const manager = buildManager()
    const doc = paragraphDoc([textNode('hello', [{ type: 'highlight', attrs: { color: null } }])])
    expect(manager.serialize(doc)).toBe('==hello==')
  })

  it('still parses ==text== back into a colourless highlight mark', () => {
    const manager = buildManager()
    const parsed = manager.parse('==hello==')
    const mark = parsed.content[0].content[0].marks[0]
    expect(mark.type).toBe('highlight')
  })
})

describe('nested colour + highlight on the same run', () => {
  it('serializes as nested style-attr bracket spans and parses back with both marks', () => {
    const manager = buildManager()
    const doc = paragraphDoc([
      textNode('hello', [
        { type: 'textStyle', attrs: { color: '#D32F2F' } },
        { type: 'highlight', attrs: { color: '#FFF59D' } }
      ])
    ])
    const markdown = manager.serialize(doc)

    const parsed = manager.parse(markdown)
    const marks = parsed.content[0].content[0].marks
    const markTypes = marks.map((mark) => mark.type).sort()
    expect(markTypes).toEqual(['highlight', 'textStyle'])
    const highlightMark = marks.find((mark) => mark.type === 'highlight')
    const textStyleMark = marks.find((mark) => mark.type === 'textStyle')
    expect(highlightMark.attrs.color).toBe('#FFF59D')
    expect(textStyleMark.attrs.color).toBe('#D32F2F')
  })
})

describe('text-align round-trip (paragraph/heading node attribute)', () => {
  it('serializes a centered paragraph with a trailing style attr', () => {
    const manager = buildManager()
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [textNode('hi')] }]
    }
    expect(manager.serialize(doc)).toBe('hi {style="text-align: center;"}')
  })

  it('parses that trailing style attr back into the textAlign attribute', () => {
    const manager = buildManager()
    const parsed = manager.parse('hi {style="text-align: center;"}')
    expect(parsed.content[0].attrs.textAlign).toBe('center')
    expect(parsed.content[0].content[0].text).toBe('hi')
  })

  it('omits the style attr entirely for left-aligned (default) paragraphs', () => {
    const manager = buildManager()
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'left' }, content: [textNode('hi')] }]
    }
    expect(manager.serialize(doc)).toBe('hi')
  })

  it('round-trips a right-aligned heading', () => {
    const manager = buildManager()
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, textAlign: 'right' },
          content: [textNode('title')]
        }
      ]
    }
    const markdown = manager.serialize(doc)
    expect(markdown).toBe('## title {style="text-align: right;"}')

    const parsed = manager.parse(markdown)
    expect(parsed.content[0].type).toBe('heading')
    expect(parsed.content[0].attrs.textAlign).toBe('right')
    expect(parsed.content[0].attrs.level).toBe(2)
  })
})
