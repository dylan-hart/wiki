import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractMentionCandidates, matchMention, MAX_MENTION_CANDIDATES } from './mentions.ts'

describe('helpers/mentions', () => {
  describe('extractMentionCandidates', () => {
    it('returns lowercased, de-duplicated handles in order of first appearance', () => {
      assert.deepEqual(extractMentionCandidates('@Bob and @ann and @bob again'), ['bob', 'ann'])
    })

    it('adds the trailing-punctuation-stripped variant of a token', () => {
      assert.deepEqual(extractMentionCandidates('ping @bob.smith.'), ['bob.smith.', 'bob.smith'])
    })

    it('skips an @ that follows a handle character, as in an email address', () => {
      assert.deepEqual(extractMentionCandidates('mail alice@example.com'), [])
    })

    it('returns nothing for content without mentions', () => {
      assert.deepEqual(extractMentionCandidates('no mentions here'), [])
    })

    it('ignores an over-long token', () => {
      assert.deepEqual(extractMentionCandidates(`@${'a'.repeat(65)}`), [])
    })

    it('caps the candidate set', () => {
      const content = Array.from({ length: 500 }, (_, i) => `@u${i}`).join(' ')
      assert.equal(extractMentionCandidates(content).length, MAX_MENTION_CANDIDATES)
    })
  })

  describe('matchMention', () => {
    const resolved = new Map([
      ['bob', 'Bob'],
      ['bob.', 'Bob.']
    ])

    it('prefers the longest resolved variant', () => {
      assert.deepEqual(matchMention('bob.', resolved), { length: 4, handle: 'Bob.' })
    })

    it('falls back to the stripped variant', () => {
      assert.deepEqual(matchMention('bob-', resolved), { length: 3, handle: 'Bob' })
    })

    it('returns null when nothing resolves', () => {
      assert.equal(matchMention('carol', resolved), null)
    })
  })
})
