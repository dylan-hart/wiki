import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyKeywordHighlight, clearKeywordHighlight } from './renderedContent'

/**
 * OpenProject #2541 (Feature #2539): the in-page keyword highlight/find pass that wraps every
 * literal, case-insensitive substring match of a keyword in a new `<mark data-keyword-highlight>`
 * element -- a `TreeWalker` walk over the rendered content's text nodes, deliberately NOT a raw
 * string regex/replace against the HTML (see the file header of `renderedContent.js` and the WP's
 * own description for why: matching inside tag attributes, URLs, or markup `enhanceRenderedContent`
 * already injected).
 */

function setContent(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('applyKeywordHighlight', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('returns no matches and does nothing for a null root', () => {
    expect(applyKeywordHighlight(null, 'foo')).toEqual({ matches: [] })
  })

  it('wraps a single literal match in a <mark data-keyword-highlight>', () => {
    const root = setContent('<p>A page about foxes and forests.</p>')
    const { matches } = applyKeywordHighlight(root, 'foxes')

    expect(matches).toHaveLength(1)
    expect(matches[0].tagName).toBe('MARK')
    expect(matches[0].dataset.keywordHighlight).toBe('')
    expect(matches[0].textContent).toBe('foxes')
    expect(root.innerHTML).toContain('<mark')
    expect(root.textContent).toBe('A page about foxes and forests.')
  })

  it('matches case-insensitively but preserves the original casing of the matched text', () => {
    const root = setContent('<p>Foxes, FOXES, and foxes everywhere.</p>')
    const { matches } = applyKeywordHighlight(root, 'foxes')

    expect(matches.map((m) => m.textContent)).toEqual(['Foxes', 'FOXES', 'foxes'])
  })

  it('wraps every match within a single text node, in order', () => {
    const root = setContent('<p>cat cat cat</p>')
    const { matches } = applyKeywordHighlight(root, 'cat')

    expect(matches).toHaveLength(3)
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(3)
    // -> Order is document order, left to right
    expect(root.textContent).toBe('cat cat cat')
  })

  it('wraps matches across multiple elements, in document order', () => {
    const root = setContent('<h1>About foxes</h1><p>Foxes are clever.</p><p>No match here.</p>')
    const { matches } = applyKeywordHighlight(root, 'foxes')

    expect(matches).toHaveLength(2)
    expect(matches[0].closest('h1')).not.toBeNull()
    expect(matches[1].closest('p')).not.toBeNull()
  })

  it('matches a substring inside a longer word', () => {
    const root = setContent('<p>Categorically speaking.</p>')
    const { matches } = applyKeywordHighlight(root, 'cat')

    expect(matches).toHaveLength(1)
    expect(matches[0].textContent).toBe('Cat')
  })

  it('finds nothing and touches no DOM when the term is absent', () => {
    const root = setContent('<p>Nothing to see here.</p>')
    const before = root.innerHTML
    const { matches } = applyKeywordHighlight(root, 'zzz-not-present')

    expect(matches).toHaveLength(0)
    expect(root.innerHTML).toBe(before)
  })

  it('treats a blank or whitespace-only term as no highlight, clearing any existing one', () => {
    const root = setContent('<p>Foxes and forests.</p>')
    applyKeywordHighlight(root, 'foxes')
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(1)

    const { matches } = applyKeywordHighlight(root, '   ')
    expect(matches).toHaveLength(0)
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(0)
  })

  it('does not match inside <script> or <style> text', () => {
    const root = setContent(
      '<p>foxes</p><script>const foxes = 1</script><style>.foxes { color: red; }</style>'
    )
    const { matches } = applyKeywordHighlight(root, 'foxes')

    expect(matches).toHaveLength(1)
    expect(matches[0].closest('p')).not.toBeNull()
  })

  it('re-running with the same term after an unrelated call does not double-wrap already-marked text', () => {
    const root = setContent('<p>Foxes and forests.</p>')
    const first = applyKeywordHighlight(root, 'foxes')
    expect(first.matches).toHaveLength(1)

    // -> A second pass over unchanged content, as an unrelated re-render might trigger
    const second = applyKeywordHighlight(root, 'foxes')
    expect(second.matches).toHaveLength(1)
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(1)
    // -> Still a single, non-nested mark -- not a mark wrapping a mark
    expect(root.querySelectorAll('mark[data-keyword-highlight] mark')).toHaveLength(0)
  })

  it('clears the previous term and re-highlights when the term changes', () => {
    const root = setContent('<p>Foxes and wolves in the forest.</p>')
    applyKeywordHighlight(root, 'foxes')
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(1)

    const { matches } = applyKeywordHighlight(root, 'wolves')
    expect(matches).toHaveLength(1)
    expect(matches[0].textContent).toBe('wolves')
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(1)
    expect(root.textContent).toBe('Foxes and wolves in the forest.')
  })

  it('handles a term that spans no special regex characters literally, not as a pattern', () => {
    const root = setContent('<p>Price: $5 (five dollars).</p>')
    const { matches } = applyKeywordHighlight(root, '$5')

    expect(matches).toHaveLength(1)
    expect(matches[0].textContent).toBe('$5')
  })
})

describe('clearKeywordHighlight', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does nothing for a null root', () => {
    expect(() => clearKeywordHighlight(null)).not.toThrow()
  })

  it('unwraps every mark back to its original text, merging adjacent text nodes', () => {
    const root = setContent('<p>Foxes and forests.</p>')
    applyKeywordHighlight(root, 'foxes')
    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(1)

    clearKeywordHighlight(root)

    expect(root.querySelectorAll('mark[data-keyword-highlight]')).toHaveLength(0)
    expect(root.textContent).toBe('Foxes and forests.')
    expect(root.innerHTML).toBe('<p>Foxes and forests.</p>')
  })

  it('is a no-op when there is nothing to clear', () => {
    const root = setContent('<p>Nothing marked.</p>')
    const before = root.innerHTML
    clearKeywordHighlight(root)
    expect(root.innerHTML).toBe(before)
  })

  it('leaves an author-written <mark> from markdown content alone -- it carries no data attribute', () => {
    const root = setContent('<p>An <mark>author-highlighted</mark> word, and foxes too.</p>')
    applyKeywordHighlight(root, 'foxes')

    clearKeywordHighlight(root)

    expect(root.querySelector('mark')).not.toBeNull()
    expect(root.querySelector('mark').textContent).toBe('author-highlighted')
  })
})
