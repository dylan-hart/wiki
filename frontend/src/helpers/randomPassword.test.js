import { afterEach, describe, expect, it, vi } from 'vitest'

import { randomPassword } from './randomPassword'

describe('randomPassword', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a string of the requested length', () => {
    expect(randomPassword(16, 'abc')).toHaveLength(16)
    expect(randomPassword(0, 'abc')).toHaveLength(0)
    expect(randomPassword(1, 'abc')).toHaveLength(1)
  })

  it('only uses characters from the given alphabet', () => {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const password = randomPassword(200, alphabet)
    for (const char of password) {
      expect(alphabet).toContain(char)
    }
  })

  it('can produce repeated characters (samples with replacement)', () => {
    // With only two possible characters and a long draw, seeing every generated string be a
    // strict alternation/permutation with no repeat would be astronomically unlikely -- this
    // pins down that generation is with-replacement sampling, not without-replacement.
    const alphabet = 'ab'
    const password = randomPassword(64, alphabet)
    const hasRepeatPair = /(.)\1/.test(password)
    expect(hasRepeatPair).toBe(true)
  })

  it('never calls Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random')
    randomPassword(
      64,
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_*=?#!()+-$%&.'
    )
    expect(randomSpy).not.toHaveBeenCalled()
  })

  it('draws from crypto.getRandomValues', () => {
    const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues')
    randomPassword(16, 'abc')
    expect(getRandomValuesSpy).toHaveBeenCalled()
  })

  it('throws on an empty alphabet', () => {
    expect(() => randomPassword(8, '')).toThrow()
  })

  it('rejects out-of-range Uint32 draws instead of introducing modulo bias', () => {
    // Force the very first draw above any non-power-of-two threshold, then a second, in-range
    // draw -- proving a too-large draw is discarded and redrawn rather than reduced with `%`.
    const alphabet = 'abc' // threshold = 0x100000000 - (0x100000000 % 3), well below 0xFFFFFFFF
    let call = 0
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((buffer) => {
      call++
      if (call === 1) {
        buffer[0] = 0xffffffff // rejected: at/above threshold for alphabet length 3
      } else {
        buffer[0] = 0 // accepted: maps to alphabet[0]
      }
      return buffer
    })
    expect(randomPassword(1, alphabet)).toBe('a')
    expect(call).toBeGreaterThanOrEqual(2)
  })
})
