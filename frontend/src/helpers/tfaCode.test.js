import { describe, expect, it } from 'vitest'

import { formatRecoveryCodeInput, isValidTfaCode } from './tfaCode.js'

describe('formatRecoveryCodeInput', () => {
  it('uppercases and groups a raw 16-character code into four dash-separated blocks', () => {
    expect(formatRecoveryCodeInput('abcd1234efgh5678')).toBe('ABCD-1234-EFGH-5678')
  })

  it('strips existing dashes and stray whitespace before regrouping', () => {
    expect(formatRecoveryCodeInput('abcd-1234 efgh\t5678')).toBe('ABCD-1234-EFGH-5678')
  })

  it('reformats progressively as the user types a partial code', () => {
    expect(formatRecoveryCodeInput('abcd1')).toBe('ABCD-1')
    expect(formatRecoveryCodeInput('abcd')).toBe('ABCD')
  })

  it('truncates input beyond 16 significant characters rather than growing extra groups', () => {
    expect(formatRecoveryCodeInput('abcd1234efgh5678extra')).toBe('ABCD-1234-EFGH-5678')
  })

  it('handles empty/nullish input without throwing', () => {
    expect(formatRecoveryCodeInput('')).toBe('')
    expect(formatRecoveryCodeInput(undefined)).toBe('')
  })
})

describe('isValidTfaCode', () => {
  it('accepts a 6-digit code in TOTP mode', () => {
    expect(isValidTfaCode('123456', false)).toBe(true)
  })

  it('rejects a wrong-length or non-numeric value in TOTP mode', () => {
    expect(isValidTfaCode('12345', false)).toBe(false)
    expect(isValidTfaCode('12345a', false)).toBe(false)
    expect(isValidTfaCode('', false)).toBe(false)
  })

  it('rejects a well-formed recovery code in TOTP mode', () => {
    expect(isValidTfaCode('ABCD-1234-EFGH-5678', false)).toBe(false)
  })

  it('accepts a properly-grouped recovery code in recovery mode', () => {
    expect(isValidTfaCode('ABCD-1234-EFGH-5678', true)).toBe(true)
  })

  it('rejects a 6-digit code in recovery mode', () => {
    expect(isValidTfaCode('123456', true)).toBe(false)
  })

  it('rejects a recovery code with a character outside the Crockford alphabet', () => {
    // -> I, L, O, U are deliberately excluded from the alphabet
    expect(isValidTfaCode('ABCD-1234-EFGI-5678', true)).toBe(false)
    expect(isValidTfaCode('ABCD-1234-EFGH-567O', true)).toBe(false)
  })

  it('rejects a recovery code missing its dash grouping', () => {
    expect(isValidTfaCode('ABCD1234EFGH5678', true)).toBe(false)
  })

  it('rejects a recovery code with the wrong number of groups', () => {
    expect(isValidTfaCode('ABCD-1234-EFGH', true)).toBe(false)
    expect(isValidTfaCode('ABCD-1234-EFGH-5678-9ABC', true)).toBe(false)
  })
})
