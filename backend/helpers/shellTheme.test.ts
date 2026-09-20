import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { themeShellFragments } from './shellTheme.ts'

describe('themeShellFragments', () => {
  test('no theme or empty fields produce no fragments', () => {
    assert.deepEqual(themeShellFragments(undefined), {})
    assert.deepEqual(themeShellFragments(null), {})
    assert.deepEqual(themeShellFragments({ injectCSS: '', injectHead: '', injectBody: '' }), {})
  })

  test('non-string fields are ignored', () => {
    assert.deepEqual(themeShellFragments({ injectCSS: 1, injectHead: {}, injectBody: null }), {})
  })

  test('CSS becomes a style element the SPA later replaces by id, ahead of the head markup', () => {
    const { head } = themeShellFragments({
      injectCSS: 'body { color: red }',
      injectHead: '<meta name="verify" content="abc">'
    })
    assert.equal(
      head,
      '<style id="theme-inject-css">body { color: red }</style><meta name="verify" content="abc">'
    )
  })

  test('head markup alone is passed verbatim', () => {
    const { head, bodyEnd } = themeShellFragments({ injectHead: '<script src="/x.js"></script>' })
    assert.equal(head, '<script src="/x.js"></script>')
    assert.equal(bodyEnd, undefined)
  })

  test('body markup is passed verbatim', () => {
    assert.equal(
      themeShellFragments({ injectBody: '<div id="b">$&</div>' }).bodyEnd,
      '<div id="b">$&</div>'
    )
  })

  test('a closing style tag inside the CSS cannot end the style element early', () => {
    const { head } = themeShellFragments({ injectCSS: 'a{}</STYLE><script>x</script>' })
    assert.equal(head!.match(/<\/style>/gi)?.length, 1)
    assert.ok(head!.endsWith('</style>'))
  })
})
