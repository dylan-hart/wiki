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
    // -> Anchored on the end, so it only matches when the full (untruncated) string is seen. An
    //    input longer than the cap must therefore come back false: the pattern never gets to see
    //    the suffix that would have made it match.
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
    // -> Classic ReDoS shape: exponential backtracking against a string that never matches.
    const result = testRegexSafely('^(a+)+$', `${'a'.repeat(60)}!`)
    const elapsed = Date.now() - start
    assert.equal(result, false)
    // -> Generous ceiling for CI jitter -- the point is this is milliseconds, not the
    //    seconds-to-minutes an unguarded `.test()` would take against this input.
    assert.ok(elapsed < 2000, `expected the guarded test to resolve quickly, took ${elapsed}ms`)
  })

  test('does not evaluate flags from the pattern text itself', () => {
    // -> Regression guard: the sandboxed script is built from the pattern/input as *values*, not
    //    string-concatenated into source, so pattern text cannot break out of the RegExp literal.
    assert.equal(testRegexSafely('a', 'a'), true)
    assert.equal(testRegexSafely("a', globalThis.__pwned = true, '", 'x'), false)
  })
})
