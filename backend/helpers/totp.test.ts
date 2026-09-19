import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from './totp.ts'

// -> RFC 6238 Appendix B's SHA-1 vector: the 20-byte ASCII secret "12345678901234567890" in base32.
//    Its published values are 8 digits; `codeAt`'s `binary % 10**6` truncation makes the expected
//    6-digit code their last six (94287082 -> 287082 at counter 1), since 10**6 divides 10**8.
const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const codeAtCounter = {
  0: '755224',
  1: '287082',
  2: '359152',
  3: '969429'
}

function withFakeTime(epochMs: number, run: () => void) {
  mock.timers.enable({ apis: ['Date'], now: epochMs })
  try {
    run()
  } finally {
    mock.timers.reset()
  }
}

describe('generateTotpSecret', () => {
  test('returns an unpadded base32 string of the expected length', () => {
    const secret = generateTotpSecret()
    assert.match(secret, /^[A-Z2-7]{32}$/)
  })

  test('is random -- two calls do not collide', () => {
    assert.notEqual(generateTotpSecret(), generateTotpSecret())
  })
})

describe('buildTotpUri', () => {
  test('builds an otpauth:// URI with the fixed RFC 6238 parameters', () => {
    const uri = buildTotpUri({ secret: rfcSecret, account: 'alice@example.com', issuer: 'My Wiki' })
    assert.ok(uri.startsWith('otpauth://totp/'))

    const [, query] = uri.split('?')
    const params = new URLSearchParams(query)
    assert.equal(params.get('secret'), rfcSecret)
    assert.equal(params.get('issuer'), 'My Wiki')
    assert.equal(params.get('algorithm'), 'SHA1')
    assert.equal(params.get('digits'), '6')
    assert.equal(params.get('period'), '30')
  })

  test('URI-encodes a label containing reserved characters', () => {
    const uri = buildTotpUri({ secret: rfcSecret, account: 'a:b?c', issuer: 'Wiki: Prod' })
    const label = uri.slice('otpauth://totp/'.length, uri.indexOf('?'))
    assert.equal(decodeURIComponent(label), 'Wiki: Prod:a:b?c')
    assert.ok(!label.includes('?'), 'a literal ? in the label would truncate the query string')
  })
})

describe('verifyTotpCode', () => {
  // -> At 59_000ms, `counter = floor(59000 / 1000 / 30) = 1`, and `codeAtCounter`'s keys are that
  //    counter value, so each assertion below also names the window that matched.
  test('accepts the code for the current 30s window, returning its counter', () => {
    withFakeTime(59_000, () => {
      assert.equal(verifyTotpCode(rfcSecret, codeAtCounter[1]), 1)
    })
  })

  test('accepts the previous window (clock drift, -30s), returning its counter', () => {
    withFakeTime(59_000, () => {
      assert.equal(verifyTotpCode(rfcSecret, codeAtCounter[0]), 0)
    })
  })

  test('accepts the next window (clock drift, +30s), returning its counter', () => {
    withFakeTime(59_000, () => {
      assert.equal(verifyTotpCode(rfcSecret, codeAtCounter[2]), 2)
    })
  })

  test('rejects a code two windows away -- outside the allowed drift', () => {
    withFakeTime(59_000, () => {
      assert.equal(verifyTotpCode(rfcSecret, codeAtCounter[3]), -1)
    })
  })

  test('rejects a code that matches no nearby window', () => {
    withFakeTime(59_000, () => {
      assert.equal(verifyTotpCode(rfcSecret, '000000'), -1)
    })
  })

  test('rejects malformed input without decoding the secret', () => {
    assert.equal(verifyTotpCode(rfcSecret, '12345'), -1)
    assert.equal(verifyTotpCode(rfcSecret, '1234567'), -1)
    assert.equal(verifyTotpCode(rfcSecret, 'abcdef'), -1)
  })

  test('rejects an empty secret', () => {
    assert.equal(verifyTotpCode('', '287082'), -1)
  })

  test('rejects a secret that is not valid base32 rather than throwing', () => {
    assert.equal(verifyTotpCode('not-base32!!!', '287082'), -1)
  })

  test('still compares every drift candidate even once a match is found, and identifies which one', () => {
    // -> `node:crypto`'s named exports are immutable ESM-namespace bindings a mock cannot redefine,
    //    so comparisons are counted through the configurable `Buffer` global instead: every
    //    candidate is wrapped in `Buffer.from(..., 'utf8')` immediately before the comparison it
    //    feeds, one call per drift candidate.
    const bufferFromSpy = mock.method(Buffer, 'from')
    try {
      withFakeTime(59_000, () => {
        // -> The +30s candidate is compared last, so a loop returning on the first hit would stop
        //    at the two earlier misses and never reach it.
        const beforeCallCount = bufferFromSpy.mock.callCount()
        const result = verifyTotpCode(rfcSecret, codeAtCounter[2])
        const candidateCallCount = bufferFromSpy.mock.callCount() - beforeCallCount

        assert.equal(result, 2)
        // -> Five: the base32 secret, the submitted code, and one per drift candidate (-1, 0, +1).
        assert.equal(candidateCallCount, 5)
      })
    } finally {
      bufferFromSpy.mock.restore()
    }
  })
})
