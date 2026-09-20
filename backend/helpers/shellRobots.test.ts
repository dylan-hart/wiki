import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { robotsDirective, robotsShellFragments } from './shellRobots.ts'

describe('robotsDirective', () => {
  test('spells out both flags', () => {
    assert.equal(robotsDirective({ index: true, follow: true }), 'index, follow')
    assert.equal(robotsDirective({ index: false, follow: true }), 'noindex, follow')
    assert.equal(robotsDirective({ index: true, follow: false }), 'index, nofollow')
    assert.equal(robotsDirective({ index: false, follow: false }), 'noindex, nofollow')
  })

  test('only an explicit false turns a flag off', () => {
    assert.equal(robotsDirective({}), 'index, follow')
    assert.equal(robotsDirective({ index: 'false', follow: 0 }), 'index, follow')
  })

  test('no robots block means no opinion', () => {
    assert.equal(robotsDirective(undefined), undefined)
    assert.equal(robotsDirective(null), undefined)
    assert.equal(robotsDirective('noindex'), undefined)
  })
})

describe('robotsShellFragments', () => {
  test('puts a robots meta in the head', () => {
    assert.deepEqual(robotsShellFragments({ index: false, follow: false }), {
      head: '<meta name="robots" content="noindex, nofollow">'
    })
  })

  test('is empty without a robots block', () => {
    assert.deepEqual(robotsShellFragments(undefined), {})
  })
})
