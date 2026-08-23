import { describe, expect, it } from 'vitest'

import { passwordStrengthScore } from './passwordStrength'

describe('passwordStrengthScore', () => {
  it('scores an empty password at the weakest end', () => {
    expect(passwordStrengthScore('')).toBe(0)
  })

  it('scores a common, short password low', () => {
    expect(passwordStrengthScore('password')).toBeLessThanOrEqual(1)
  })

  it('scores a long, random passphrase high', () => {
    expect(passwordStrengthScore('correct horse battery staple mountain')).toBeGreaterThanOrEqual(3)
  })

  it('returns a score between 0 and 4 inclusive', () => {
    const score = passwordStrengthScore('some random test input 12345')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(4)
  })
})
