import { css } from 'lit'

/**
 * Only rules that are genuinely identical across blocks live here; a block adopts one by writing
 * `static styles = [errorBox, css`…`]`. A rule a block wants slightly differently (`.caption`'s
 * `text-align: center`, a `margin-bottom` whose selector names a different sibling in every block)
 * stays in that block, written after the shared fragment so it wins.
 */

/**
 * `white-space: pre-wrap` is what makes the second paragraph of a two-part message read as a
 * paragraph rather than run on -- which only holds if the markup around the message carries no
 * whitespace of its own, and is what `./render.js`'s `renderError()` is for.
 *
 * The gap below the block is deliberately not here: every block sets it on a selector naming its own
 * main element too (`.player, .error`, `.diagram, .error`), so that stays with the block. The eyebrow
 * and the corner marks are gated on `--block-corner-marks` rather than on switches of their own -- an
 * aesthetic that drops the marks wants no eyebrow either, so one token answers both.
 */
export const errorBox = css`
  .error {
    position: relative;
    border: var(--block-error-border);
    border-radius: var(--block-error-radius);
    background-color: var(--block-error-bg);
    padding: 1rem;
    font-size: 13.5px;
    white-space: pre-wrap;
  }

  .error::before {
    content: 'Block error';
    display: var(--block-corner-marks);
    margin-block-end: 4px;
    font: 600 9.5px var(--font-mono);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--block-accent-fg);
  }

  /* -> The two corner marks every themed block card draws -- see block-tabs/block-spoiler for the same technique. */
  .error::after {
    content: '';
    position: absolute;
    inset: 0;
    display: var(--block-corner-marks);
    pointer-events: none;
    background:
      linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 7px 1px no-repeat,
      linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 1px 7px no-repeat,
      linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 7px 1px
        no-repeat,
      linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 1px 7px
        no-repeat;
  }
`

/**
 * `errorBox`'s `.error` declarations as an inline `style` value, for a block rendered into the light
 * DOM (`block-include`, whose output is page content): Lit never adopts `static styles` without a
 * shadow root to adopt them into, and a `<style>` tag is not the answer either -- a light-DOM rule
 * for a class as generic as `.error` would reach the whole page.
 *
 * Sliced out of `errorBox` rather than retyped, so the two cannot drift apart. Stops at the FIRST `}`
 * rather than the last: only `.error` itself is a flat declaration list an inline `style` attribute
 * can hold, and the `::before`/`::after` rules cannot be expressed inline at all.
 */
export const errorBoxInline = errorBox.cssText
  .slice(errorBox.cssText.indexOf('{') + 1, errorBox.cssText.indexOf('}'))
  .trim()

/**
 * The line of text under a figure. Reads `--block-caption-fg` (set on `body` in `tailwind.css`)
 * rather than a hardcoded light/dark pair, so one declaration covers every theme and mode and a block
 * adopting this needs no `DarkMode` controller for the colour.
 */
export const captionStyles = css`
  .caption {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--block-caption-fg);
  }
`
