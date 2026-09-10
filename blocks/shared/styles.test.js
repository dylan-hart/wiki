import { describe, expect, it } from 'vitest'

import { captionStyles, errorBox, errorBoxInline } from './styles.js'

/** The declarations of a one-rule stylesheet, normalised to a comparable `prop: value` list. */
function declarationsOf(cssText) {
  const body = cssText.slice(cssText.indexOf('{') + 1, cssText.lastIndexOf('}'))
  return body
    .split(';')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

/** The declarations of just the FIRST rule in a multi-rule stylesheet. */
function firstRuleDeclarationsOf(cssText) {
  const body = cssText.slice(cssText.indexOf('{') + 1, cssText.indexOf('}'))
  return body
    .split(';')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

describe('shared/styles.js: errorBox', () => {
  it('styles `.error`, not `:host` or a block-specific class', () => {
    expect(errorBox.cssText).toContain('.error')
    expect(errorBox.cssText).not.toContain(':host')
  })

  it('draws the box off the generic --block-error-* tokens, not a hardcoded colour', () => {
    expect(firstRuleDeclarationsOf(errorBox.cssText)).toEqual([
      'position: relative',
      'border: var(--block-error-border)',
      'border-radius: var(--block-error-radius)',
      'background-color: var(--block-error-bg)',
      'padding: 1rem',
      'font-size: 13.5px',
      'white-space: pre-wrap'
    ])
  })

  it('draws a "Block error" eyebrow, shown/hidden the same way the corner marks are', () => {
    expect(errorBox.cssText).toContain('.error::before')
    expect(errorBox.cssText).toContain("content: 'Block error'")
    expect(errorBox.cssText).toContain('color: var(--block-accent-fg)')
    // -> Both the eyebrow and the corner marks key off the same token: neither one exists on
    //    Cobalt's card, which draws no corner marks either.
    const beforeRule = errorBox.cssText.slice(errorBox.cssText.indexOf('.error::before'))
    expect(beforeRule).toContain('display: var(--block-corner-marks)')
  })

  it('draws the two corner marks every themed block card draws, Ledger only', () => {
    expect(errorBox.cssText).toContain('.error::after')
    const afterRule = errorBox.cssText.slice(errorBox.cssText.indexOf('.error::after'))
    expect(afterRule).toContain('display: var(--block-corner-marks)')
    expect(afterRule).toContain('var(--block-mark-color)')
  })

  it('leaves the gap below the block to the block itself', () => {
    // -> `margin-bottom: 16px` sits on a per-block selector (`.player, .error`, `.diagram, .error`,
    //    ...) that varies from block to block, so it is deliberately not part of the shared box.
    expect(errorBox.cssText).not.toContain('margin-bottom')
  })
})

describe('shared/styles.js: errorBoxInline', () => {
  it('is the .error rule’s own declarations, with no selector, braces or pseudo-elements', () => {
    // -> `block-include` renders into the light DOM, where `static styles` is never adopted, so its
    //    error box has to be an inline `style` value. Derived from `errorBox` rather than retyped,
    //    so the two cannot drift. The eyebrow/corner-marks rules are pseudo-elements and cannot be
    //    expressed inline at all, so they are correctly left out rather than pulled in as garbage.
    expect(errorBoxInline).not.toContain('{')
    expect(errorBoxInline).not.toContain('}')
    expect(errorBoxInline).not.toContain('::before')
    expect(errorBoxInline).not.toContain('::after')
    expect(declarationsOf(`x{${errorBoxInline}}`)).toEqual(
      firstRuleDeclarationsOf(errorBox.cssText)
    )
  })
})

describe('shared/styles.js: captionStyles', () => {
  it('styles `.caption` with one rule for every theme/mode, not a :host([dark]) override', () => {
    expect(captionStyles.cssText).toContain('.caption')
    // -> The colour now varies through --block-caption-fg (set on `body`, tailwind.css) rather than
    //    a hardcoded light/dark pair, so there is no separate dark selector to key off any more.
    expect(captionStyles.cssText).not.toContain(':host')
  })

  it('carries the size, gap and colour token the captioned blocks share', () => {
    // -> `text-align: center` is katex's and mathjax's own, not every captioned block's, so it stays
    //    in the blocks that want it.
    expect(captionStyles.cssText).toContain('margin-top: 8px')
    expect(captionStyles.cssText).toContain('font-size: 12.5px')
    expect(captionStyles.cssText).toContain('color: var(--block-caption-fg)')
    expect(captionStyles.cssText).not.toContain('text-align')
  })
})
