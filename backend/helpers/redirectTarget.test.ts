import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeRedirectTarget, sanitizeRedirectTarget } from './redirectTarget.ts'

describe('isSafeRedirectTarget', () => {
  test('refuses a scheme-relative //host target', () => {
    assert.equal(isSafeRedirectTarget('//attacker.example'), false)
  })

  test('refuses a /\\host target that browsers normalise to //', () => {
    assert.equal(isSafeRedirectTarget('/\\attacker.example'), false)
  })

  test('refuses a javascript: target', () => {
    assert.equal(isSafeRedirectTarget('javascript:alert(1)'), false)
  })

  test('refuses a data: target', () => {
    assert.equal(isSafeRedirectTarget('data:text/html,<script>alert(1)</script>'), false)
  })

  test('accepts a bare rooted path', () => {
    assert.equal(isSafeRedirectTarget('/en/home'), true)
  })

  test('accepts a complete https:// URL', () => {
    assert.equal(isSafeRedirectTarget('https://wiki.example.com/en/home'), true)
  })

  test('refuses a non-string value', () => {
    assert.equal(isSafeRedirectTarget(undefined), false)
  })
})

describe('sanitizeRedirectTarget', () => {
  test('falls back to / by default when refused', () => {
    assert.equal(sanitizeRedirectTarget('//attacker.example'), '/')
  })

  test('falls back to a supplied fallback when refused', () => {
    assert.equal(sanitizeRedirectTarget('javascript:alert(1)', '/login'), '/login')
  })

  test('passes a safe target through unchanged', () => {
    assert.equal(sanitizeRedirectTarget('/en/home'), '/en/home')
  })
})
