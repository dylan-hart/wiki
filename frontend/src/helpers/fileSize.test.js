import { describe, expect, it } from 'vitest'

import { formatFileSize, parseFileSize } from './fileSize.js'

describe('parseFileSize', () => {
  it('parses a bare byte count', () => {
    expect(parseFileSize('0')).toBe(0)
    expect(parseFileSize('512')).toBe(512)
  })

  it('parses binary (base-1024) units, case-insensitively', () => {
    expect(parseFileSize('1KB')).toBe(1024)
    expect(parseFileSize('1kb')).toBe(1024)
    expect(parseFileSize('1MB')).toBe(1024 ** 2)
    expect(parseFileSize('1GB')).toBe(1024 ** 3)
    expect(parseFileSize('1TB')).toBe(1024 ** 4)
  })

  it('parses decimal amounts', () => {
    expect(parseFileSize('1.5 MB')).toBe(Math.round(1.5 * 1024 ** 2))
  })

  it('accepts a unit with no space before it', () => {
    expect(parseFileSize('10MB')).toBe(10 * 1024 ** 2)
  })

  it('accepts a unit with a space before it', () => {
    expect(parseFileSize('10 MB')).toBe(10 * 1024 ** 2)
  })

  it('trims surrounding whitespace', () => {
    expect(parseFileSize('  10 MB  ')).toBe(10 * 1024 ** 2)
  })

  it('throws on an unparseable string', () => {
    expect(() => parseFileSize('not a size')).toThrow()
    expect(() => parseFileSize('10 XB')).toThrow()
    expect(() => parseFileSize('')).toThrow()
  })
})

describe('formatFileSize', () => {
  it('renders whole binary multiples with no decimal noise', () => {
    expect(formatFileSize(5 * 1024 ** 2)).toBe('5 MB')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1024 ** 3)).toBe('1 GB')
  })

  it('round-trips with parseFileSize at the unit boundaries', () => {
    for (const bytes of [0, 1023, 1024, 1024 ** 2, 1024 ** 3]) {
      expect(parseFileSize(formatFileSize(bytes))).toBe(bytes)
    }
  })
})

// Task 3178: replaces the `filesize` dependency's `filesize(bytes, { base: 2, standard: 'jedec' })`
// call. These values pin the exact strings that call produced, captured against the real
// `filesize@11.0.22` package before it was removed, so a future change to `formatFileSize` cannot
// silently drift from what readers were already shown. 2 ** 30 - 1 is the one entry that looks
// surprising at a glance: it is one byte short of 1 GB, but rounds to "1024.00" at the MB step, and
// `formatFileSize` (matching `filesize`) promotes that to the next unit rather than printing the
// threshold value verbatim.
describe('formatFileSize table (pinned against filesize@11.0.22, base 2 / jedec)', () => {
  const TABLE = [
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 ** 6, '976.56 KB'],
    [2 ** 20, '1 MB'],
    [2 ** 30 - 1, '1 GB'],
    [5 * 2 ** 40, '5 TB'],
    // -> A realistic `os.totalmem()` shape (16 GiB) -- the same value the backend's ramTotal table
    //    test in `backend/helpers/common.test.ts` uses.
    [17179869184, '16 GB']
  ]

  for (const [bytes, expected] of TABLE) {
    it(`formats ${bytes} bytes as "${expected}"`, () => {
      expect(formatFileSize(bytes)).toBe(expected)
    })
  }
})
