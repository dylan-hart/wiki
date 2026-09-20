import { describe, expect, it } from 'vitest'

import { findMentionTrigger, MENTION_QUERY_MAX_LENGTH } from './mentionTrigger'

describe('findMentionTrigger', () => {
  it('finds the token ending at the caret', () => {
    expect(findMentionTrigger('hello @al', 9)).toEqual({ start: 6, end: 9, query: 'al' })
  })

  it('opens at the start of the text', () => {
    expect(findMentionTrigger('@bob', 4)).toEqual({ start: 0, end: 4, query: 'bob' })
  })

  it('accepts every handle character', () => {
    expect(findMentionTrigger('@Al.ice_9-x', 11)?.query).toBe('Al.ice_9-x')
  })

  it('opens after whitespace and punctuation that is not a handle character', () => {
    expect(findMentionTrigger('(@bo', 4)?.query).toBe('bo')
    expect(findMentionTrigger('a\n@bo', 5)?.query).toBe('bo')
  })

  it('needs at least one character after the @', () => {
    expect(findMentionTrigger('hi @', 4)).toBeNull()
  })

  it('does not open inside an email address', () => {
    expect(findMentionTrigger('mail a@b.com', 12)).toBeNull()
    expect(findMentionTrigger('a@b', 3)).toBeNull()
  })

  it('does not open when the caret is past a space or another character', () => {
    expect(findMentionTrigger('@bob ', 5)).toBeNull()
    expect(findMentionTrigger('@bob!', 5)).toBeNull()
  })

  it('does not open for a query longer than a handle can be', () => {
    const long = 'a'.repeat(MENTION_QUERY_MAX_LENGTH + 1)
    expect(findMentionTrigger(`@${long}`, long.length + 1)).toBeNull()
    const exact = 'a'.repeat(MENTION_QUERY_MAX_LENGTH)
    expect(findMentionTrigger(`@${exact}`, exact.length + 1)?.query).toBe(exact)
  })

  it('reports an end that runs over handle characters after the caret', () => {
    expect(findMentionTrigger('@alice rest', 3)).toEqual({ start: 0, end: 6, query: 'al' })
  })

  it('returns null with no @ at all', () => {
    expect(findMentionTrigger('plain text', 5)).toBeNull()
    expect(findMentionTrigger('', 0)).toBeNull()
  })
})
