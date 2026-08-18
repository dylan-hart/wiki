import { afterEach, describe, expect, it } from 'vitest'

import { applyInjectCss } from './injectCss.js'

afterEach(() => {
  document.querySelector('#theme-inject-css')?.remove()
})

describe('applyInjectCss()', () => {
  it('creates a #theme-inject-css style element with the given CSS', () => {
    applyInjectCss('body { color: red; }')

    const styleEl = document.querySelector('#theme-inject-css')
    expect(styleEl).not.toBeNull()
    expect(styleEl.tagName).toBe('STYLE')
    expect(styleEl.textContent).toBe('body { color: red; }')
  })

  it('applies the CSS raw and unscoped, with no wrapping selector', () => {
    applyInjectCss('.foo { color: blue; }')

    const styleEl = document.querySelector('#theme-inject-css')
    expect(styleEl.textContent).toBe('.foo { color: blue; }')
  })

  it('leaves no element behind for an empty string', () => {
    applyInjectCss('')

    expect(document.querySelector('#theme-inject-css')).toBeNull()
  })

  it('removes a previously-injected empty <style> rather than leaving an empty tag', () => {
    applyInjectCss('body { color: red; }')
    applyInjectCss('')

    expect(document.querySelector('#theme-inject-css')).toBeNull()
  })

  it('replaces rather than duplicates the element on repeated calls', () => {
    applyInjectCss('body { color: red; }')
    applyInjectCss('body { color: green; }')
    applyInjectCss('body { color: blue; }')

    const elements = document.querySelectorAll('#theme-inject-css')
    expect(elements.length).toBe(1)
    expect(elements[0].textContent).toBe('body { color: blue; }')
  })

  it('is idempotent when called repeatedly with the same value, as a watcher firing on unrelated state would', () => {
    applyInjectCss('.x { color: red; }')
    applyInjectCss('.x { color: red; }')
    applyInjectCss('.x { color: red; }')

    const elements = document.querySelectorAll('#theme-inject-css')
    expect(elements.length).toBe(1)
    expect(elements[0].textContent).toBe('.x { color: red; }')
  })
})
