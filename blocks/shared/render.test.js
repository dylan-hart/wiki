import { render } from 'lit'
import { afterEach, describe, expect, it } from 'vitest'

import { renderError } from './render.js'

function into(template) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  render(template, host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shared/render.js: renderError()', () => {
  it('draws the message inside the shared .error box', () => {
    const box = into(renderError('This diagram could not be drawn.')).querySelector('.error')

    expect(box).not.toBeNull()
    expect(box.textContent).toBe('This diagram could not be drawn.')
  })

  it('leaves no whitespace of its own around the message', () => {
    // -> `errorBox` sets `white-space: pre-wrap`, so the markup's own indentation would be drawn.
    //    That is exactly what the hand-written multi-line `<div class="error">` blocks this replaces
    //    would have started doing once they adopted the shared box.
    const box = into(renderError('short')).querySelector('.error')

    expect(box.textContent).toBe('short')
  })

  it('draws a multi-line message as written', () => {
    const message = 'This formula could not be typeset: x\n\nThe source has to go inside a fence.'
    const box = into(renderError(message)).querySelector('.error')

    expect(box.textContent).toBe(message)
  })
})
