import { html } from 'lit'

/**
 * Markup fragments shared by more than one block.
 */

/**
 * The panel a block draws instead of itself when it cannot render what it was given.
 *
 * Pairs with `errorBox` in `./styles.js`, which is where the `.error` class it writes is styled --
 * a block using this adopts that fragment too.
 *
 * Deliberately tight around the message, with no whitespace of its own: `errorBox` sets
 * `white-space: pre-wrap`, so the indentation of a hand-written multi-line `<div class="error">` --
 * which is how several blocks used to draw a message assembled inline -- would be drawn on screen.
 * Assemble the message first, hand the finished string here.
 *
 * @param {string} message
 */
export function renderError(message) {
  return html`<div class="error">${message}</div>`
}
