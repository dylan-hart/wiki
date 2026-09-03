import { describe, expect, it } from 'vitest'

import { passwordStrengthBadge, passwordStrengthScore } from './passwordStrength'

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

/**
 * The score -> `{ color, label }` mapping that four dialogs (`UserCreateDialog`, `ChangePwdDialog`,
 * `UserChangePwdDialog`, `AuthLoginPanel`) each carried their own copy of. `t` is stubbed as an
 * identity function so the assertions pin the exact locale key each band resolves against.
 */
describe('passwordStrengthBadge', () => {
  const t = (key) => key

  const BANDS = [
    { color: 'negative', label: 'common.password.weak' },
    { color: 'deep-orange-7', label: 'common.password.poor' },
    { color: 'purple-7', label: 'common.password.average' },
    { color: 'blue-7', label: 'common.password.good' },
    { color: 'green-7', label: 'common.password.strong' }
  ]

  it('calls anything shorter than 8 characters weak, whatever it would otherwise score', () => {
    expect(passwordStrengthBadge('Tr0ub4d', t)).toEqual(BANDS[0])
    expect(passwordStrengthBadge('', t)).toEqual(BANDS[0])
  })

  it('maps every one of the five score bands, each to its own colour and label', () => {
    // -> All long enough to clear the 8-character floor, so the score alone decides the band.
    // -> Calibrated against the zxcvbn scorer currently installed: these five each land on a
    //    different score with it, so a scorer upgrade that shifts a sample's band shows up as this
    //    test failing on coverage rather than as an untested band -- re-pick the sample, don't
    //    loosen the assertion.
    const samples = [
      'aaaaaaaaaa',
      'password123456',
      'dragonfly77x',
      'Kx9#mQ2vL',
      'zJ4!vq_Mn7#tRa2Lp'
    ]

    const covered = new Set()
    for (const password of samples) {
      const score = passwordStrengthScore(password)
      covered.add(score)
      expect(passwordStrengthBadge(password, t)).toEqual(BANDS[score])
    }

    // -> The samples above must between them exercise all five bands, or the mapping is only
    //    partly covered and a wrong colour in an untested band would pass unnoticed.
    expect([...covered].sort()).toEqual([0, 1, 2, 3, 4])
  })
})
