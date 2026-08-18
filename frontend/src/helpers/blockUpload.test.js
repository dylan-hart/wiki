import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_BLOCK_UPLOAD_SIZE, validateBlockFile } from './blockUpload.js'

describe('validateBlockFile', () => {
  it('accepts a small .js file', () => {
    const file = { name: 'component.js', size: 1024 }
    expect(validateBlockFile(file, 10485760)).toEqual({ ok: true })
  })

  it('rejects a missing file', () => {
    expect(validateBlockFile(null, 10485760)).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects a non-.js extension', () => {
    const file = { name: 'component.mjs', size: 1024 }
    expect(validateBlockFile(file, 10485760)).toEqual({ ok: false, reason: 'extension' })
  })

  it('is case-insensitive about the extension', () => {
    const file = { name: 'Component.JS', size: 1024 }
    expect(validateBlockFile(file, 10485760)).toEqual({ ok: true })
  })

  it('rejects a file over the configured limit', () => {
    const file = { name: 'component.js', size: 20 }
    expect(validateBlockFile(file, 10)).toEqual({ ok: false, reason: 'size' })
  })

  it('accepts a file exactly at the limit', () => {
    const file = { name: 'component.js', size: 10 }
    expect(validateBlockFile(file, 10)).toEqual({ ok: true })
  })

  it('falls back to the default max size when none is given', () => {
    const file = { name: 'component.js', size: DEFAULT_MAX_BLOCK_UPLOAD_SIZE + 1 }
    expect(validateBlockFile(file)).toEqual({ ok: false, reason: 'size' })
  })

  it('treats a non-positive max size as unlimited', () => {
    const file = { name: 'component.js', size: 999999999 }
    expect(validateBlockFile(file, 0)).toEqual({ ok: true })
  })
})
