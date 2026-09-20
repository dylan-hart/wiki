import { describe, expect, it } from 'vitest'

import { resolveWordMarkup } from './markdownMarkup'

/**
 * Guards against a `TypeError` on a null word: `resolveWordMarkup` only sees the resolved word or
 * its absence, never why it is absent, so every real-editor trigger -- an empty line, an empty
 * document, a cursor between the two `~` of an empty subscript -- reaches it the same way, as
 * `word: null`. Two buttons suffice: the branching is identical for every symmetric-wrap button.
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
