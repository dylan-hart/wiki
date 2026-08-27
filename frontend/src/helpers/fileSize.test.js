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
