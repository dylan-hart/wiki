import { afterEach, describe, expect, it } from 'vitest'

import { replaceHeadStyle } from './headStyle.js'

afterEach(() => {
  document.querySelector('#head-style-probe')?.remove()
})

describe('replaceHeadStyle()', () => {
  it('creates a <style> element with the given id and CSS', () => {
    replaceHeadStyle('head-style-probe', 'body { color: red; }')

    const styleEl = document.querySelector('#head-style-probe')
    expect(styleEl.tagName).toBe('STYLE')
    expect(styleEl.textContent).toBe('body { color: red; }')
  })

  it('leaves no element behind for empty or missing CSS', () => {
    replaceHeadStyle('head-style-probe', 'body { color: red; }')
    replaceHeadStyle('head-style-probe', '')
    expect(document.querySelector('#head-style-probe')).toBeNull()

    replaceHeadStyle('head-style-probe', null)
    expect(document.querySelector('#head-style-probe')).toBeNull()
  })

  it('replaces rather than stacks on repeated calls', () => {
    replaceHeadStyle('head-style-probe', '.a { color: red; }')
    replaceHeadStyle('head-style-probe', '.a { color: blue; }')

    const elements = document.querySelectorAll('#head-style-probe')
    expect(elements.length).toBe(1)
    expect(elements[0].textContent).toBe('.a { color: blue; }')
  })
})
