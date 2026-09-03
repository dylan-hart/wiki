import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteLinkText, rewriteRedirectTarget } from './pageLinkRewrite.ts'

describe('rewriteLinkText', () => {
  test('rewrites a bare markdown link target', () => {
    const result = rewriteLinkText('See [the docs](docs/old) for more.', 'docs/old', 'docs/new')
    assert.equal(result.changed, true)
    assert.equal(result.text, 'See [the docs](docs/new) for more.')
  })

  test('rewrites a rooted markdown link target, keeping the leading slash', () => {
    const result = rewriteLinkText('[Link](/docs/old)', 'docs/old', 'docs/new')
    assert.equal(result.changed, true)
    assert.equal(result.text, '[Link](/docs/new)')
  })

  test('preserves a trailing fragment and query string', () => {
    const result = rewriteLinkText('[Link](docs/old#section?x=1)', 'docs/old', 'docs/new')
    assert.equal(result.text, '[Link](docs/new#section?x=1)')
  })

  test('rewrites a double-quoted href attribute', () => {
    const result = rewriteLinkText('<a href="docs/old">go</a>', 'docs/old', 'docs/new')
    assert.equal(result.text, '<a href="docs/new">go</a>')
  })

  test('rewrites a single-quoted, rooted href attribute', () => {
    const result = rewriteLinkText("<a href='/docs/old'>go</a>", 'docs/old', 'docs/new')
    assert.equal(result.text, "<a href='/docs/new'>go</a>")
  })

  test('rewrites every occurrence', () => {
    const result = rewriteLinkText(
      '[one](docs/old) and <a href="docs/old">two</a>',
      'docs/old',
      'docs/new'
    )
    assert.equal(result.text, '[one](docs/new) and <a href="docs/new">two</a>')
  })

  test('does not touch a link to a different, longer path sharing the same prefix', () => {
    const result = rewriteLinkText('[Link](docs/old-and-more)', 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
    assert.equal(result.text, '[Link](docs/old-and-more)')
  })

  test('does not touch a link to an unrelated path', () => {
    const result = rewriteLinkText('[Link](docs/other)', 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
  })

  test('leaves an external link alone even when its path segment matches', () => {
    const result = rewriteLinkText('[Link](https://example.com/docs/old)', 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
  })

  test('is a no-op on empty text', () => {
    const result = rewriteLinkText('', 'docs/old', 'docs/new')
    assert.deepEqual(result, { text: '', changed: false })
  })

  test('refuses an empty oldPath rather than matching every bare link opener', () => {
    const result = rewriteLinkText('[Home](  ) and <a href="">home</a>', '', 'new-home')
    assert.equal(result.changed, false)
  })

  test('is a no-op when oldPath and newPath are the same', () => {
    const result = rewriteLinkText('[Link](docs/same)', 'docs/same', 'docs/same')
    assert.equal(result.changed, false)
  })

  test('escapes regex-special characters in the path', () => {
    const result = rewriteLinkText('[Link](docs/a.b+c)', 'docs/a.b+c', 'docs/new')
    assert.equal(result.text, '[Link](docs/new)')
  })
})

describe('rewriteRedirectTarget', () => {
  test('rewrites a page-kind redirect target', () => {
    const content = JSON.stringify({ kind: 'page', target: '/docs/old', showInterstitial: false })
    const result = rewriteRedirectTarget(content, 'docs/old', 'docs/new')
    assert.equal(result.changed, true)
    assert.deepEqual(JSON.parse(result.text), {
      kind: 'page',
      target: '/docs/new',
      showInterstitial: false
    })
  })

  test('leaves a url-kind redirect untouched', () => {
    const content = JSON.stringify({ kind: 'url', target: 'https://example.com/docs/old' })
    const result = rewriteRedirectTarget(content, 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
    assert.equal(result.text, content)
  })

  test('leaves a redirect pointed elsewhere untouched', () => {
    const content = JSON.stringify({ kind: 'page', target: '/docs/other' })
    const result = rewriteRedirectTarget(content, 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
  })

  test('is a no-op on malformed content', () => {
    const result = rewriteRedirectTarget('not json', 'docs/old', 'docs/new')
    assert.equal(result.changed, false)
    assert.equal(result.text, 'not json')
  })

  test('refuses an empty oldPath', () => {
    const content = JSON.stringify({ kind: 'page', target: '/' })
    const result = rewriteRedirectTarget(content, '', 'docs/new')
    assert.equal(result.changed, false)
  })
})
