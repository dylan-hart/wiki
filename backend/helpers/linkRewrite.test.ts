import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteInternalLinkReferences } from './linkRewrite.ts'

describe('rewriteInternalLinkReferences (OpenProject #2424/#2452/#2453)', () => {
  test('rewrites a root-relative href, in both render and content', () => {
    const render = '<p>See <a href="/old-page">here</a>.</p>'
    const content = 'See [here](/old-page).'
    const result = rewriteInternalLinkReferences(
      render,
      content,
      'docs/page',
      'old-page',
      'new-page'
    )
    assert.ok(result)
    assert.equal(result!.render, '<p>See <a href="/new-page">here</a>.</p>')
    assert.equal(result!.content, 'See [here](/new-page).')
  })

  test('rewrites a folder-relative href, recomputed relative to the SAME referencing folder', () => {
    // -> 'docs/page' lives in folder 'docs'; 'sibling' resolves to 'docs/sibling'
    const render = '<p><a href="sibling">Sibling</a></p>'
    const content = 'See [Sibling](sibling).'
    const result = rewriteInternalLinkReferences(
      render,
      content,
      'docs/page',
      'docs/sibling',
      'docs/renamed-sibling'
    )
    assert.ok(result)
    assert.equal(result!.render, '<p><a href="renamed-sibling">Sibling</a></p>')
    assert.equal(result!.content, 'See [Sibling](renamed-sibling).')
  })

  test('rewrites an ../-relative href when the move crosses folders', () => {
    // -> 'docs/child/page' lives in folder 'docs/child'; '../sibling' resolves to 'docs/sibling'
    const render = '<p><a href="../sibling">Sibling</a></p>'
    const result = rewriteInternalLinkReferences(
      render,
      '',
      'docs/child/page',
      'docs/sibling',
      'top-level'
    )
    assert.ok(result)
    // -> 'top-level' relative to 'docs/child' is '../../top-level'
    assert.equal(result!.render, '<p><a href="../../top-level">Sibling</a></p>')
  })

  test('rewrites every anchor pointing at the moved page, not just the first', () => {
    const render = '<p><a href="/old">One</a> and <a href="/old">Two</a></p>'
    const result = rewriteInternalLinkReferences(render, '', 'docs/page', 'old', 'new')
    assert.ok(result)
    assert.equal(result!.render, '<p><a href="/new">One</a> and <a href="/new">Two</a></p>')
  })

  test('leaves an anchor pointing elsewhere untouched', () => {
    const render = '<p><a href="/unrelated-page">Elsewhere</a></p>'
    const result = rewriteInternalLinkReferences(render, '', 'docs/page', 'old-page', 'new-page')
    assert.equal(result, null)
  })

  test('ignores external, mailto, protocol-relative and fragment-only hrefs', () => {
    const render =
      '<p><a href="https://example.com/old-page">Ext</a> ' +
      '<a href="mailto:old-page@example.com">Mail</a> ' +
      '<a href="//example.com/old-page">ProtoRel</a> ' +
      '<a href="#old-page">Frag</a></p>'
    const result = rewriteInternalLinkReferences(render, '', 'docs/page', 'old-page', 'new-page')
    assert.equal(result, null)
  })

  test('returns null when the page has no anchors at all', () => {
    const result = rewriteInternalLinkReferences(
      '<p>No links here.</p>',
      'No links here.',
      'docs/page',
      'old',
      'new'
    )
    assert.equal(result, null)
  })

  test('best-effort content sync: rewrites render even when the literal href text is absent from content', () => {
    // -> Simulates a reference-style markdown link whose definition line uses different text than
    //    what ended up in the rendered href, or any other case where content and the literal href
    //    string have drifted -- render (what a reader sees) is still corrected.
    const render = '<p><a href="/old-page">here</a></p>'
    const content = 'See [here][ref].\n\n[ref]: something-else-entirely'
    const result = rewriteInternalLinkReferences(
      render,
      content,
      'docs/page',
      'old-page',
      'new-page'
    )
    assert.ok(result)
    assert.equal(result!.render, '<p><a href="/new-page">here</a></p>')
    assert.equal(result!.content, content)
  })

  test('a self-referencing page rewrites its own link to itself', () => {
    // -> The moved page's own content, called with its NEW path as pagePath (where it now lives)
    const render = '<p>See <a href="/old-page">this very page</a>.</p>'
    const content = 'See [this very page](/old-page).'
    const result = rewriteInternalLinkReferences(
      render,
      content,
      'new-page',
      'old-page',
      'new-page'
    )
    assert.ok(result)
    assert.equal(result!.render, '<p>See <a href="/new-page">this very page</a>.</p>')
    assert.equal(result!.content, 'See [this very page](/new-page).')
  })

  test('handles an empty render without throwing', () => {
    const result = rewriteInternalLinkReferences('', '', 'docs/page', 'old', 'new')
    assert.equal(result, null)
  })
})
