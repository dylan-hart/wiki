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
 *
 * Retheme (OpenProject #2876, `ui-iteration/blocks.md` "Shared fragments" > `errorBox`): the panel now
 * reads the generic `--block-*` custom-property set OpenProject #2874/#2875 already put on `body` in
 * `tailwind.css` -- `--block-error-border`/`-bg`/`-radius` already resolve to "dashed in the accent
 * fill, on the card colour" (Ledger) and "dashed, 6px, on the accent wash" (Cobalt) exactly as the spec
 * calls for, in both light and dark, with no new token needed. `::before` draws the Roboto Mono
 * "Block error" eyebrow the spec gives Ledger, in `--block-accent-fg`; `::after` draws the same two
 * corner marks every other themed block card carries. Both are gated on `--block-corner-marks`
 * ("block" Ledger / "none" Cobalt) rather than a dedicated switch of their own -- Cobalt's card has no
 * corner marks either, so one token answers both. This is a deliberate simplification of the spec's
 * Cobalt-specific "bold the message's first line instead" treatment: doing that literally needs either
 * a new token in `tailwind.css` (a file this task does not own this round) or a light-DOM span
 * `render.js` would have to wrap the message in (`render.js` is not this task's either) -- an eyebrow
 * in both aesthetics reads as the same idea ("this is a block error") without either.
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
 * DOM.
 *
 * `block-include` is the one such block -- what it renders is page content, which has to be styled by
 * the article's own stylesheet -- and Lit never adopts `static styles` without a shadow root to adopt
 * them into. A `<style>` tag in its output is not the answer either: `.error` is a generic enough
 * class name that a light-DOM rule for it would reach the whole page.
 *
 * Sliced out of `errorBox` rather than retyped, so the two cannot drift apart. Stops at the FIRST `}`
 * rather than the last: `errorBox` now carries three rules (`.error`, `::before`, `::after`), and only
 * the first is a flat declaration list an inline `style` attribute can hold -- the eyebrow and corner
 * marks are pseudo-elements, which cannot be expressed inline at all, so they are correctly left out
 * rather than pulled in as invalid text.
 */
export const errorBoxInline = errorBox.cssText
  .slice(errorBox.cssText.indexOf('{') + 1, errorBox.cssText.indexOf('}'))
  .trim()

/**
 * The line of text under a figure -- a diagram, a formula, a drawing.
 *
 * Quieter and smaller than the body around it, in both themes. Retheme (OpenProject #2876,
 * `ui-iteration/blocks.md`): reads `--block-caption-fg` (`tailwind.css`, OpenProject #2874/#2875)
 * rather than a hardcoded light/dark pair, so the colour now also varies correctly for Cobalt, not
 * just Ledger dark -- one declaration for all four states instead of a `:host([dark])` override, the
 * same "set it on `body` and let it inherit" convention every other themed block property already
 * uses. A block adopting this needs no `DarkMode` controller for the colour any more, though every
 * block that draws a caption already constructs one for other reasons.
 */
export const captionStyles = css`
  .caption {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--block-caption-fg);
  }
`
