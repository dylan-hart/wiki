import { html } from 'lit'

/**
 * The `.error` class this writes is styled by `errorBox` in `./styles.js`, which a block using this
 * adopts too. That fragment sets `white-space: pre-wrap`, hence no whitespace of its own here: a
 * hand-written multi-line `<div class="error">` would draw its own indentation. Assemble the message
 * first, hand the finished string over.
 */
export function renderError(message) {
  return html`<div class="error">${message}</div>`
}
