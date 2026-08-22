import { describe, expect, it } from 'vitest'

import {
  renameFileName,
  sanitizeBaseName,
  splitBaseName,
  validateBaseName
} from './pendingAssetRename'

describe('splitBaseName', () => {
  it('splits a normal file name into base and extension', () => {
    expect(splitBaseName('a1b2c3.png')).toEqual({ base: 'a1b2c3', ext: 'png' })
  })

  it('treats a name with no dot as pure base', () => {
    expect(splitBaseName('screenshot')).toEqual({ base: 'screenshot', ext: '' })
  })

  it('treats a leading-dot dotfile as pure base rather than an empty base with an extension', () => {
    expect(splitBaseName('.gitignore')).toEqual({ base: '.gitignore', ext: '' })
  })

  it('splits on the last dot for a name with multiple dots', () => {
    expect(splitBaseName('quarterly.report.final.pdf')).toEqual({
      base: 'quarterly.report.final',
      ext: 'pdf'
    })
  })
})

describe('sanitizeBaseName', () => {
  it('lowercases and collapses whitespace to dashes', () => {
    expect(sanitizeBaseName('Team Photo 2026')).toBe('team-photo-2026')
  })

  it('reduces a pasted path to its last segment, like path.basename', () => {
    expect(sanitizeBaseName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeBaseName('folder\\name')).toBe('name')
  })

  it('strips characters outside the safe set', () => {
    expect(sanitizeBaseName('résumé!*@')).toBe('rsum')
  })

  it('strips leading dots so the result cannot become a hidden file', () => {
    expect(sanitizeBaseName('...secret')).toBe('secret')
  })

  it('collapses a run of dots to one', () => {
    expect(sanitizeBaseName('a....b')).toBe('a.b')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeBaseName('  spaced  ')).toBe('spaced')
  })

  it('truncates an excessively long name', () => {
    const result = sanitizeBaseName('a'.repeat(500))
    expect(result.length).toBe(200)
  })

  it('reduces a name of nothing but disallowed characters to empty', () => {
    expect(sanitizeBaseName('///\\\\')).toBe('')
  })
})

describe('validateBaseName', () => {
  it('rejects an empty name', () => {
    expect(validateBaseName('')).toBe('File name cannot be empty.')
  })

  it('accepts a non-empty sanitized name', () => {
    expect(validateBaseName('team-photo')).toBeNull()
  })
})

describe('renameFileName', () => {
  it('renames the base while keeping the extension fixed', () => {
    expect(renameFileName('3f2504e0-4f89-11d3-9a0c-0305e82c3301.png', 'Vacation Photo')).toEqual({
      ok: true,
      fileName: 'vacation-photo.png'
    })
  })

  it('rejects a rename that sanitizes down to nothing', () => {
    expect(renameFileName('abc123.jpg', '   ')).toEqual({
      ok: false,
      error: 'File name cannot be empty.'
    })
  })

  it('rejects a rename made entirely of path separators', () => {
    expect(renameFileName('abc123.jpg', '///')).toEqual({
      ok: false,
      error: 'File name cannot be empty.'
    })
  })

  it('preserves the fixed extension even when the typed name carries its own dot', () => {
    expect(renameFileName('abc123.png', 'report.v2')).toEqual({
      ok: true,
      fileName: 'report.v2.png'
    })
  })

  it('produces a bare base name when the original file name has no extension', () => {
    expect(renameFileName('screenshot', 'renamed')).toEqual({
      ok: true,
      fileName: 'renamed'
    })
  })

  it('collapses the doubled dot a trailing-dot base creates once joined with the extension', () => {
    // -> "foo." sanitizes to itself (a single trailing dot, not a run `sanitizeBaseName` would
    //    collapse on its own) and only becomes a doubled dot once `.png` is appended after it
    expect(renameFileName('abc123.png', 'foo.')).toEqual({
      ok: true,
      fileName: 'foo.png'
    })
    expect(renameFileName('abc123.png', 'foo..')).toEqual({
      ok: true,
      fileName: 'foo.png'
    })
  })
})
