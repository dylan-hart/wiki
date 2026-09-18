import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { convertTiptapJsonToMarkdown, isLegacyWysiwygJson } from './wysiwygHeadlessMarkdown.ts'

describe('isLegacyWysiwygJson', () => {
  test('true for content starting with { (leading whitespace tolerated)', () => {
    assert.equal(isLegacyWysiwygJson('{"type":"doc","content":[]}'), true)
    assert.equal(isLegacyWysiwygJson('  \n{"type":"doc"}'), true)
  })

  test('false for real markdown, real HTML, null and undefined', () => {
    assert.equal(isLegacyWysiwygJson('# Heading\n\nSome text.'), false)
    assert.equal(isLegacyWysiwygJson('<p>hi</p>'), false)
    assert.equal(isLegacyWysiwygJson(''), false)
    assert.equal(isLegacyWysiwygJson(null), false)
    assert.equal(isLegacyWysiwygJson(undefined), false)
  })
})

describe('convertTiptapJsonToMarkdown', () => {
  test('converts headings, marks, links, lists and code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'world' },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
              text: 'a link'
            }
          ]
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item one' }] }]
            }
          ]
        },
        {
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const x = 1' }]
        }
      ]
    }

    const markdown = convertTiptapJsonToMarkdown(doc)
    assert.match(markdown, /^# Title/)
    assert.match(markdown, /Hello \*\*world\*\* and \[a link]\(https:\/\/example\.com\)/)
    assert.match(markdown, /- item one/)
    assert.match(markdown, /```js\nconst x = 1\n```/)
  })

  test('converts images, task lists and tables', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'alt text' } },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done thing' }] }]
            }
          ]
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H1' }] }]
                }
              ]
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C1' }] }]
                }
              ]
            }
          ]
        }
      ]
    }

    const markdown = convertTiptapJsonToMarkdown(doc)
    assert.match(markdown, /!\[alt text]\(https:\/\/example\.com\/a\.png\)/)
    assert.match(markdown, /- \[x] done thing/)
    assert.match(markdown, /\| H1 {2}\|/)
    assert.match(markdown, /\| C1 {2}\|/)
  })

  test('throws for JSON that parses but is not a Tiptap document', () => {
    assert.throws(() => convertTiptapJsonToMarkdown({ not: 'a doc' }), /Not a Tiptap document/)
    assert.throws(() => convertTiptapJsonToMarkdown(null), /Not a Tiptap document/)
    assert.throws(() => convertTiptapJsonToMarkdown('just a string'), /Not a Tiptap document/)
    assert.throws(() => convertTiptapJsonToMarkdown({ type: 'doc' }), /Not a Tiptap document/)
  })

  test('an empty document converts to empty (or near-empty) markdown rather than throwing', () => {
    const markdown = convertTiptapJsonToMarkdown({ type: 'doc', content: [] })
    assert.equal(markdown.trim(), '')
  })
})
