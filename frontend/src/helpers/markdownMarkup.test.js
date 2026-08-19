import { describe, expect, it } from 'vitest'

import { resolveWordMarkup } from './markdownMarkup'

/**
 * Regression coverage for OpenProject #800: `toggleMarkup` (`EditorMarkdown.vue`) crashed with a
 * `TypeError` when `getWordAtPosition()` returned `null` -- an empty line, an empty document, or a
 * cursor adjacent to non-word markup with nothing between the markers (e.g. between the two `~` in
 * an empty `~~` subscript, or beside a bare `^`). `resolveWordMarkup` only sees the resolved word
 * (or its absence) rather than why it's absent, so all three real-editor triggers reach it the same
 * way: `word: null`. Exercised for two of the affected toolbar buttons (Bold, symmetric; Inline
 * Code, single-character) since the branching is identical for every symmetric-wrap button.
 */
describe('resolveWordMarkup', () => {
  describe('no word under the cursor (getWordAtPosition() returned null)', () => {
    const scenarios = [
      ['an empty line', null],
      ['an empty document', null],
      [
        'a cursor adjacent to non-word markup with nothing inside it (e.g. between `~` and `~`)',
        null
      ]
    ]

    it.each(scenarios)('bold: inserts empty markers at the cursor -- %s', (_label, word) => {
      expect(resolveWordMarkup({ start: '**', end: '**', word })).toEqual({
        text: '****',
        atCursor: true
      })
    })

    it.each(scenarios)('inline code: inserts empty markers at the cursor -- %s', (_label, word) => {
      expect(resolveWordMarkup({ start: '`', end: '`', word })).toEqual({
        text: '``',
        atCursor: true
      })
    })

    it('handles asymmetric markers (keyboard key) the same way', () => {
      expect(resolveWordMarkup({ start: '<kbd>', end: '</kbd>', word: null })).toEqual({
        text: '<kbd></kbd>',
        atCursor: true
      })
    })
  })

  describe('a word is under the cursor', () => {
    it('bold: wraps a plain word', () => {
      expect(resolveWordMarkup({ start: '**', end: '**', word: 'hello' })).toEqual({
        text: '**hello**',
        atCursor: false
      })
    })

    it('bold: unwraps an already-bolded word', () => {
      expect(resolveWordMarkup({ start: '**', end: '**', word: '**hello**' })).toEqual({
        text: 'hello',
        atCursor: false
      })
    })

    it('inline code: wraps a plain word', () => {
      expect(resolveWordMarkup({ start: '`', end: '`', word: 'hello' })).toEqual({
        text: '`hello`',
        atCursor: false
      })
    })

    it('inline code: unwraps an already-coded word', () => {
      expect(resolveWordMarkup({ start: '`', end: '`', word: '`hello`' })).toEqual({
        text: 'hello',
        atCursor: false
      })
    })
  })
})
