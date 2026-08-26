import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findUnsafeNavigationTarget,
  isSafeNavigationTarget,
  sanitizeNavigationTargets
} from './navigationTarget.ts'

describe('isSafeNavigationTarget', () => {
  test('accepts an absent or empty target', () => {
    assert.equal(isSafeNavigationTarget(undefined), true)
    assert.equal(isSafeNavigationTarget(null), true)
    assert.equal(isSafeNavigationTarget(''), true)
    assert.equal(isSafeNavigationTarget('   '), true)
  })

  test('accepts a rooted path', () => {
    assert.equal(isSafeNavigationTarget('/some/page'), true)
    assert.equal(isSafeNavigationTarget('/'), true)
  })

  test('accepts a complete http(s) URL', () => {
    assert.equal(isSafeNavigationTarget('https://example.com/x'), true)
    assert.equal(isSafeNavigationTarget('http://example.com'), true)
  })

  test('rejects a protocol-relative //host address', () => {
    assert.equal(isSafeNavigationTarget('//evil.example'), false)
  })

  test('rejects the /\\host form browsers normalise to //', () => {
    assert.equal(isSafeNavigationTarget('/\\evil.example'), false)
  })

  test('rejects javascript: targets, including the scheme-confusion form', () => {
    assert.equal(isSafeNavigationTarget('javascript:alert(1)'), false)
    // -> `javascript:` isn't a WHATWG "special" scheme, so this still parses to protocol
    //    `javascript:` despite the `//` and the encoded newline that fools a naive
    //    `/^[a-z][a-z0-9+.-]*:\/\//i` prefix regex (see epic #2208's own writeup).
    assert.equal(isSafeNavigationTarget('javascript://%0aalert(1)'), false)
  })

  test('rejects a data: URL', () => {
    assert.equal(isSafeNavigationTarget('data:text/html,<script>alert(1)</script>'), false)
  })

  test('rejects a bare, unparseable string', () => {
    assert.equal(isSafeNavigationTarget('not a url at all'), false)
  })
})

describe('findUnsafeNavigationTarget', () => {
  test('returns null when every target is safe', () => {
    assert.equal(
      findUnsafeNavigationTarget([
        { target: '/a' },
        { target: 'https://example.com', children: [{ target: '/nested' }] }
      ]),
      null
    )
  })

  test('finds an unsafe top-level target', () => {
    assert.equal(
      findUnsafeNavigationTarget([{ target: 'javascript:alert(1)' }]),
      'javascript:alert(1)'
    )
  })

  test('finds an unsafe target nested several levels deep', () => {
    const items = [
      {
        target: '/a',
        children: [
          {
            target: '/b',
            children: [{ target: 'javascript:alert(1)' }]
          }
        ]
      }
    ]
    assert.equal(findUnsafeNavigationTarget(items), 'javascript:alert(1)')
  })
})

describe('sanitizeNavigationTargets', () => {
  test('leaves safe targets untouched', () => {
    const items = [
      { id: '1', target: '/a' },
      { id: '2', target: 'https://example.com' }
    ]
    assert.deepEqual(sanitizeNavigationTargets(items), items)
  })

  test('drops an unsafe target rather than carrying it over', () => {
    const [sanitized] = sanitizeNavigationTargets([{ id: '1', target: 'javascript:alert(1)' }])
    assert.equal(sanitized.target, undefined)
    assert.equal(sanitized.id, '1')
  })

  test('sanitizes a target nested inside children', () => {
    const [sanitized] = sanitizeNavigationTargets([
      { id: '1', target: '/a', children: [{ id: '2', target: 'javascript:alert(1)' }] }
    ])
    assert.equal(sanitized.children?.[0].target, undefined)
  })
})
