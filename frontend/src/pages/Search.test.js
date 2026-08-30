import { describe, expect, it } from 'vitest'
import { extractTags, MAX_QUERY_LENGTH } from './searchTags.js'

/**
 * The regex `extractTags()` replaces (see `searchTags.js`'s own header comment for the full
 * derivation). Kept here, private to the test file, purely as an oracle to differential-test
 * against on cases too fiddly to hand-verify -- never re-exported for production use.
 */
const legacyTagsInQueryRgx = /#[a-z0-9-㐀-䶿一-鿿]+(?=(?:[^"]*(?:")[^"]*(?:"))*[^"]*$)/g

function legacyExtractTags(query) {
  return Array.from(query.matchAll(legacyTagsInQueryRgx)).map((t) => t[0].substring(1))
}

describe('extractTags', () => {
  it('extracts every tag from an unquoted query', () => {
    expect(extractTags('#one #two #three')).toEqual(['one', 'two', 'three'])
  })

  it('extracts no tags from an empty or tag-less query', () => {
    expect(extractTags('')).toEqual([])
    expect(extractTags('just some words')).toEqual([])
  })

  it('excludes a #tag-shaped token that lies inside a quoted phrase', () => {
    expect(extractTags('#a "quoted #nope phrase" #b')).toEqual(['a', 'b'])
  })

  it('excludes multiple quoted phrases, keeping tags outside each', () => {
    expect(extractTags('#a "one #x" #b "two #y" #c')).toEqual(['a', 'b', 'c'])
  })

  it('matches CJK tag characters, same character class as the old regex', () => {
    expect(extractTags('#日本語 #中文')).toEqual(['日本語', '中文'])
  })

  it('reproduces the old regex on an odd number of quotes (one stray quote)', () => {
    const query = '#a "b #c'
    expect(extractTags(query)).toEqual(legacyExtractTags(query))
    expect(extractTags(query)).toEqual(['c'])
  })

  it('reproduces the old regex on an odd number of quotes (three quotes)', () => {
    const query = '#a "b" #c "d'
    expect(extractTags(query)).toEqual(legacyExtractTags(query))
    expect(extractTags(query)).toEqual([])
  })

  it('reproduces the old regex across a table of quoted/unquoted/odd-quote queries', () => {
    const cases = [
      '#one #two',
      '#one "two #skip" #three',
      'no tags here',
      '#a"b',
      '"#a" #b',
      '#a "b" "c #d" #e',
      '#a "b #c" "d',
      '"""',
      '#a""#b',
      '"unterminated #a #b'
    ]
    for (const query of cases) {
      expect(extractTags(query)).toEqual(legacyExtractTags(query))
    }
  })

  it('completes promptly on a ~100KB adversarial query (long tag run + many quotes)', () => {
    // Deliberately NOT differential-tested against `legacyExtractTags` here -- this exact shape
    // (a long tag run followed by a long run of quotes) is the quadratic-backtracking case being
    // fixed, so running the old regex against it would defeat the point of the test.
    const query = `#${'a'.repeat(50_000)}${'"'.repeat(50_000)}`
    const start = performance.now()
    const tags = extractTags(query)
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(500)
    expect(tags).toEqual(['a'.repeat(50_000)])
  })
})

describe('MAX_QUERY_LENGTH', () => {
  it('is a positive, generous bound', () => {
    expect(MAX_QUERY_LENGTH).toBeGreaterThan(100)
  })
})
