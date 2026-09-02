import { css } from 'lit'

/**
 * Shared stylesheet fragments, for blocks.
 *
 * A block styles itself off `:host` in its own shadow root, so there is no page-level stylesheet for
 * two blocks to share a rule through -- every block's `static styles` is its own. What can be shared
 * is the rule itself: Lit accepts an array of `CSSResult`s, so a block adopts one of these by writing
 * `static styles = [errorBox, css`…`]` and drops its own copy.
 *
 * Only rules that were genuinely identical across blocks live here. A rule a block wants slightly
 * differently (`.caption`'s `text-align: center`, the `margin-bottom` that names a different sibling
 * selector in every block) stays in that block, written after the shared fragment so it wins.
 */

/**
 * The panel a block draws instead of itself when it cannot render what it was given.
 *
 * Copied verbatim into twenty blocks before this existed (BLK-F1 / INFRA-F6), ten of which declared
 * `.error` twice over. The gap below the block is deliberately not here: every block sets it on a
 * selector naming its own main element too (`.player, .error`, `.diagram, .error`, ...), so that
 * stays with the block.
 *
 * `white-space: pre-wrap` is what makes the second paragraph of a two-part message -- the "the source
 * has to go inside a fenced code block" hint `./figure.js` appends -- read as a paragraph rather than
 * run on. Seven blocks already had it; the rest carry single-line messages, which render identically
 * either way, so long as the markup around the message carries no whitespace of its own. That is what
 * `./render.js`'s `renderError()` is for.
 */
export const errorBox = css`
  .error {
    color: var(--q-negative, #c10015);
    border: 1px dashed color-mix(in srgb, currentColor 50%, transparent);
    border-radius: 5px;
    padding: 1rem;
    white-space: pre-wrap;
  }
`

/**
 * `errorBox`'s declarations as an inline `style` value, for a block rendered into the light DOM.
 *
 * `block-include` is the one such block -- what it renders is page content, which has to be styled by
 * the article's own stylesheet -- and Lit never adopts `static styles` without a shadow root to adopt
 * them into. A `<style>` tag in its output is not the answer either: `.error` is a generic enough
 * class name that a light-DOM rule for it would reach the whole page.
 *
 * Sliced out of `errorBox` rather than retyped, so the two cannot drift apart.
 */
export const errorBoxInline = errorBox.cssText
  .slice(errorBox.cssText.indexOf('{') + 1, errorBox.cssText.lastIndexOf('}'))
  .trim()

/**
 * The line of text under a figure -- a diagram, a formula, a drawing.
 *
 * Quieter and smaller than the body around it, in both themes. A block adopting this needs a
 * `DarkMode` controller (`./theme.js`) for the `[dark]` half to ever match, which every block that
 * draws a caption already constructs.
 */
export const captionStyles = css`
  .caption {
    color: #424242;
    font-size: 0.8em;
  }
  :host([dark]) .caption {
    color: rgba(255, 255, 255, 0.7);
  }
`
