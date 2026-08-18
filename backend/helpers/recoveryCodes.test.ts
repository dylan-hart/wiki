import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  isRecoveryCodeShape,
  normalizeRecoveryCode
} from './recoveryCodes.ts'

describe('helpers/recoveryCodes', () => {
  test('generateRecoveryCode produces four dash-separated groups of four from the restricted alphabet', () => {
    const code = generateRecoveryCode()
    assert.match(
      code,
      /^[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/
    )
  })

  test('generateRecoveryCode never emits the visually-ambiguous letters I, L, O, U', () => {
    // -> Run enough times that a codec bug letting one of these through would show up reliably.
    for (let i = 0; i < 200; i++) {
      const code = generateRecoveryCode()
      assert.ok(!/[ILOU]/.test(code), `unexpected ambiguous character in ${code}`)
    }
  })

  test('generateRecoveryCodes returns RECOVERY_CODE_COUNT codes, all distinct', () => {
    const codes = generateRecoveryCodes()
    assert.equal(codes.length, RECOVERY_CODE_COUNT)
    assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT)
  })

  test('normalizeRecoveryCode strips dashes/whitespace and uppercases', () => {
    assert.equal(normalizeRecoveryCode('ab12-cd34-ef56-gh78'), 'AB12CD34EF56GH78')
    assert.equal(normalizeRecoveryCode('  AB12 CD34-EF56-GH78  '), 'AB12CD34EF56GH78')
  })

  test('isRecoveryCodeShape accepts a code with or without its display dashes', () => {
    const code = generateRecoveryCode()
    assert.equal(isRecoveryCodeShape(code), true)
    assert.equal(isRecoveryCodeShape(code.replaceAll('-', '')), true)
    assert.equal(isRecoveryCodeShape(code.toLowerCase()), true)
  })

  test('isRecoveryCodeShape rejects a 6-digit TOTP code', () => {
    assert.equal(isRecoveryCodeShape('123456'), false)
  })

  test('isRecoveryCodeShape rejects the wrong length and characters outside the alphabet', () => {
    assert.equal(isRecoveryCodeShape('ABCD-ABCD-ABCD-ABC'), false)
    assert.equal(isRecoveryCodeShape('IIII-LLLL-OOOO-UUUU'), false)
    assert.equal(isRecoveryCodeShape(''), false)
  })
})
