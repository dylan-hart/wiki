import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { REGEX_TEST_MAX_INPUT_LENGTH, testRegexSafely } from './safeRegexTest.ts'

describe('testRegexSafely', () => {
  test('returns true for a matching pattern', () => {
    assert.equal(testRegexSafely('^[^@]+@allowed\\.example$', 'user@allowed.example'), true)
  })

  test('returns false for a non-matching pattern', () => {
    assert.equal(testRegexSafely('^[^@]+@allowed\\.example$', 'user@denied.example'), false)
  })

  test('returns false, not a throw, for a pattern that fails to compile', () => {
    assert.equal(testRegexSafely('(unterminated', 'user@allowed.example'), false)
  })

  test('truncates the input to REGEX_TEST_MAX_INPUT_LENGTH before testing', () => {
    // -> End-anchored, so an over-cap input must come back false: the pattern never sees the
    //    suffix that would have matched.
    const long = `${'a'.repeat(REGEX_TEST_MAX_INPUT_LENGTH)}@allowed.example`
    assert.equal(testRegexSafely('@allowed\\.example$', long), false)
  })

  test('still matches a legitimate input right at the cap', () => {
    const atCap =
      'a'.repeat(REGEX_TEST_MAX_INPUT_LENGTH - 'x@allowed.example'.length) + 'x@allowed.example'
    assert.equal(atCap.length, REGEX_TEST_MAX_INPUT_LENGTH)
    assert.equal(testRegexSafely('@allowed\\.example$', atCap), true)
  })

  test('resolves quickly and returns false for a catastrophic-backtracking pattern', () => {
    const start = Date.now()
    const result = testRegexSafely('^(a+)+$', `${'a'.repeat(60)}!`)
    const elapsed = Date.now() - start
    assert.equal(result, false)
    // -> Generous for CI jitter: the claim is milliseconds, not the seconds-to-minutes an
    //    unguarded `.test()` would take against this input.
    assert.ok(elapsed < 2000, `expected the guarded test to resolve quickly, took ${elapsed}ms`)
  })

  test('does not evaluate flags from the pattern text itself', () => {
    // -> The injection attempt stays inert because the sandboxed script takes pattern and input as
    //    values; concatenating them into its source would let this one break out.
    assert.equal(testRegexSafely('a', 'a'), true)
    assert.equal(testRegexSafely("a', globalThis.__pwned = true, '", 'x'), false)
  })
})
