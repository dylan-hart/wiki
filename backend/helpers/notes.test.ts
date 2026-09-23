import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { installTestWiki } from '../test/mocks.ts'
import {
  NOTE_EXCERPT_MAX_LENGTH,
  noteExcerpt,
  notesEnabled,
  notesEnabledIn,
  stripMarkdownLine
} from './notes.ts'

describe('notesEnabled', () => {
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      sites: {
        absent: { id: 'absent', config: { features: { browse: true } } },
        noFeatures: { id: 'noFeatures', config: {} },
        on: { id: 'on', config: { features: { notes: true } } },
        off: { id: 'off', config: { features: { notes: false } } }
      }
    })
  })

  after(() => wiki.restore())

  test('treats a site whose features carry no notes key as on', () => {
    assert.equal(notesEnabled('absent'), true)
    assert.equal(notesEnabled('noFeatures'), true)
  })

  test('follows an explicit value', () => {
    assert.equal(notesEnabled('on'), true)
    assert.equal(notesEnabled('off'), false)
  })

  test('refuses a site that does not exist', () => {
    assert.equal(notesEnabled('missing'), false)
  })
})

describe('notesEnabledIn', () => {
  test('is off only for an explicit false', () => {
    assert.equal(notesEnabledIn(undefined), true)
    assert.equal(notesEnabledIn(null), true)
    assert.equal(notesEnabledIn({}), true)
    assert.equal(notesEnabledIn({ features: {} }), true)
    assert.equal(notesEnabledIn({ features: { notes: true } }), true)
    assert.equal(notesEnabledIn({ features: { notes: false } }), false)
  })
})

describe('noteExcerpt', () => {
  test('is empty for empty or blank content', () => {
    assert.equal(noteExcerpt(''), '')
    assert.equal(noteExcerpt(null), '')
    assert.equal(noteExcerpt(undefined), '')
    assert.equal(noteExcerpt('\n   \n\t\n'), '')
  })

  test('returns the first non-empty line', () => {
    assert.equal(noteExcerpt('\n\nFirst line\nSecond line'), 'First line')
    assert.equal(noteExcerpt('First\r\nSecond'), 'First')
  })

  test('strips headings, emphasis, links, images, inline code and list markers', () => {
    assert.equal(noteExcerpt('# Meeting **notes** for _Monday_'), 'Meeting notes for Monday')
    assert.equal(noteExcerpt('- [ ] call [Alice](https://example.com)'), 'call Alice')
    assert.equal(noteExcerpt('1. run `npm test`'), 'run npm test')
    assert.equal(noteExcerpt('> quoted ~~old~~ text'), 'quoted old text')
    assert.equal(noteExcerpt('![diagram](/x.png) caption'), 'diagram caption')
    assert.equal(noteExcerpt('<p>Some <b>html</b></p>'), 'Some html')
    assert.equal(noteExcerpt('snake_case_name stays'), 'snake_case_name stays')
  })

  test('skips fenced code and block directives, whiteboard bodies included', () => {
    const content = [
      '::block-whiteboard',
      '```whiteboard',
      '{"v":2,"w":800,"h":450}',
      '{"c":"#1f2937","z":6,"p":[1,1,50]}',
      '```',
      '::',
      '',
      'After the board'
    ].join('\n')
    assert.equal(noteExcerpt(content), 'After the board')
    assert.equal(noteExcerpt('~~~\ncode\n~~~\ntext'), 'text')
    assert.equal(noteExcerpt('````\n```\ninner\n```\n````\nouter'), 'outer')
  })

  test('is empty when the only content is an unterminated fence', () => {
    assert.equal(noteExcerpt('```\nnever closed'), '')
  })

  test('skips horizontal rules and table dividers, and flattens a table row', () => {
    assert.equal(noteExcerpt('---\n***\nText'), 'Text')
    assert.equal(noteExcerpt('| Name | Owner |\n| --- | --- |'), 'Name · Owner')
    assert.equal(noteExcerpt('|---|---|\n| a | b |'), 'a · b')
    assert.equal(noteExcerpt('| a \\| b | c |'), 'a | b · c')
    assert.equal(noteExcerpt('either \\| or | both'), 'either | or | both')
  })

  test('truncates to the maximum length with an ellipsis', () => {
    const long = 'word '.repeat(60)
    const excerpt = noteExcerpt(long)
    assert.ok(Array.from(excerpt).length <= NOTE_EXCERPT_MAX_LENGTH)
    assert.ok(excerpt.endsWith('…'))
    assert.equal(noteExcerpt('x'.repeat(NOTE_EXCERPT_MAX_LENGTH)), 'x'.repeat(120))
  })

  test('counts code points, not UTF-16 units, when truncating', () => {
    const excerpt = noteExcerpt('😀'.repeat(200))
    assert.equal(Array.from(excerpt).length, NOTE_EXCERPT_MAX_LENGTH)
  })
})

describe('stripMarkdownLine', () => {
  test('collapses whitespace', () => {
    assert.equal(stripMarkdownLine('  a   b\t c  '), 'a b c')
  })
})
