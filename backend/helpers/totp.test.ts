import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from './totp.ts'

// -> RFC 6238 Appendix B's SHA-1 test vector: 20-byte ASCII secret "12345678901234567890",
//    base32-encoded with no padding. At Time=59s (counter T=1) the reference 8-digit HOTP-SHA1 value
//    is 94287082; codeAt's 6-digit truncation is `binary % 10**6`, and since 10**6 divides 10**8 that
//    is exactly the last 6 digits of the 8-digit reference value, 287082. Independently confirmed
//    against a second implementation of the same HMAC-SHA1/dynamic-truncation algorithm before use
//    here, not merely re-derived from totp.ts itself.
const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const codeAtCounter = {
  0: '755224', // Time=0..29 (T0)
  1: '287082', // Time=30..59 (T1) -- the RFC 6238 vector, Time=59
  2: '359152', // Time=60..89 (T2)
  3: '969429' // Time=90..119 (T3)
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
  // -> At Time=59_000ms, `counter = floor(59000 / 1000 / 30) = 1` -- codeAtCounter's keys are
  //    literally that counter value, so the assertions below double as "which window matched".
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
    assert.equal(verifyTotpCode(rfcSecret, '12345'), -1) // too short
    assert.equal(verifyTotpCode(rfcSecret, '1234567'), -1) // too long
    assert.equal(verifyTotpCode(rfcSecret, 'abcdef'), -1) // not digits
  })

  test('rejects an empty secret', () => {
    assert.equal(verifyTotpCode('', '287082'), -1)
  })

  test('rejects a secret that is not valid base32 rather than throwing', () => {
    assert.equal(verifyTotpCode('not-base32!!!', '287082'), -1)
  })

  test('still compares every drift candidate even once a match is found, and identifies which one', () => {
    // -> `Buffer` is a plain configurable global (unlike `node:crypto`'s named exports, which are
    //    immutable ESM-namespace bindings a mock cannot redefine), so spying on `Buffer.from` is what
    //    stands in for counting `timingSafeEqual` comparisons here: `codeAt` produces its candidate
    //    string as a plain JS string, and each one is wrapped in `Buffer.from(..., 'utf8')`
    //    immediately before the comparison it feeds -- one call per drift candidate, deterministically.
    const bufferFromSpy = mock.method(Buffer, 'from')
    try {
      withFakeTime(59_000, () => {
        // -> Matches only the +30s candidate (drift +1), which is generated and compared last -- if
        //    the loop returned on first hit instead of comparing every candidate, this would exit
        //    after the counter-0 and counter-1 misses rather than reaching the counter-2 match.
        const beforeCallCount = bufferFromSpy.mock.callCount()
        const result = verifyTotpCode(rfcSecret, codeAtCounter[2])
        const candidateCallCount = bufferFromSpy.mock.callCount() - beforeCallCount

        assert.equal(result, 2)
        // -> One `Buffer.from` to decode the base32 secret, one for the caller's own submitted code
        //    (`expected`), and one per drift candidate (-1, 0, +1) that reaches the comparison line.
        assert.equal(candidateCallCount, 5)
      })
    } finally {
      bufferFromSpy.mock.restore()
    }
  })
})
