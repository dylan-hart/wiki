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

describe('shared/styles.js: errorBox', () => {
  it('styles `.error`, not `:host` or a block-specific class', () => {
    expect(errorBox.cssText).toContain('.error')
    expect(errorBox.cssText).not.toContain(':host')
  })

  it('carries the five declarations every block had copied into it', () => {
    expect(declarationsOf(errorBox.cssText)).toEqual([
      'color: var(--q-negative, #c10015)',
      'border: 1px dashed color-mix(in srgb, currentColor 50%, transparent)',
      'border-radius: 5px',
      'padding: 1rem',
      'white-space: pre-wrap'
    ])
  })

  it('leaves the gap below the block to the block itself', () => {
    // -> `margin-bottom: 16px` sits on a per-block selector (`.player, .error`, `.diagram, .error`,
    //    ...) that varies from block to block, so it is deliberately not part of the shared box.
    expect(errorBox.cssText).not.toContain('margin-bottom')
  })
})

describe('shared/styles.js: errorBoxInline', () => {
  it('is the same declarations as errorBox, with no selector or braces', () => {
    // -> `block-include` renders into the light DOM, where `static styles` is never adopted, so its
    //    error box has to be an inline `style` value. Derived from `errorBox` rather than retyped,
    //    so the two cannot drift.
    expect(errorBoxInline).not.toContain('{')
    expect(errorBoxInline).not.toContain('}')
    expect(declarationsOf(`x{${errorBoxInline}}`)).toEqual(declarationsOf(errorBox.cssText))
  })
})

describe('shared/styles.js: captionStyles', () => {
  it('styles `.caption` in both themes', () => {
    expect(captionStyles.cssText).toContain('.caption')
    expect(captionStyles.cssText).toContain(':host([dark]) .caption')
  })

  it('carries only the two colour/size declarations the captioned blocks share', () => {
    // -> `text-align: center` is katex's and mathjax's own, not every captioned block's, so it stays
    //    in the blocks that want it.
    expect(captionStyles.cssText).toContain('color: #424242')
    expect(captionStyles.cssText).toContain('font-size: 0.8em')
    expect(captionStyles.cssText).toContain('rgba(255, 255, 255, 0.7)')
    expect(captionStyles.cssText).not.toContain('text-align')
  })
})
