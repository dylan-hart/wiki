import { describe, expect, it } from 'vitest'

import { boolean } from './props.js'

/*
 * The one thing this converter exists for: MDC writes every prop with a value, so the block picker
 * produces `autoplay="false"` for a toggle that was switched on and off again -- and Lit's own
 * Boolean converter reads any string at all, that one included, as true.
 */
describe('shared/props.js: boolean', () => {
  it('reads a missing attribute as false', () => {
    expect(boolean.converter.fromAttribute(null)).toBe(false)
  })

  it('reads the literal string "false" as false', () => {
    expect(boolean.converter.fromAttribute('false')).toBe(false)
  })

  it('reads "true", and any other present value, as true', () => {
    expect(boolean.converter.fromAttribute('true')).toBe(true)
    expect(boolean.converter.fromAttribute('')).toBe(true)
    expect(boolean.converter.fromAttribute('0')).toBe(true)
  })

  it('writes true back as "true" and false back as a removed attribute', () => {
    expect(boolean.converter.toAttribute(true)).toBe('true')
    expect(boolean.converter.toAttribute(false)).toBeNull()
  })
})
