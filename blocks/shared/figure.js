import { css } from 'lit'

/**
 * The captioned-figure blocks' shared pieces -- a formula, a diagram, a drawing, each drawn from
 * source read out of the block's own body.
 */

/**
 * Why a block has nothing to draw: its body is empty.
 *
 * Read before anything is parsed, so it says where the source goes rather than what was wrong with
 * it. A block with a fence language of its own names it, since that is what the author has to type
 * for the block to be handed the text at all; the rest just say "a fenced code block", which is what
 * their own `template` inserts.
 *
 * @param {string} subject What the block draws, as the message names it: `'diagram'`, `'formula'`.
 * @param {object} [options]
 * @param {string} [options.source] What the block calls its own input -- `'TeX source'` for the two
 *   formula blocks. `'source'` otherwise.
 * @param {string} [options.fence] The fence language the block reads, when it has one (`'kroki'`).
 * @returns {string}
 */
export function explainEmptySource(subject, { source = 'source', fence } = {}) {
  const where = fence ? `inside a \`\`\`${fence} fence` : 'inside a fenced code block'
  return `This ${subject} is empty. Its ${source} goes in the body of the block, ${where}.`
}

/**
 * The shell a typeset formula is drawn in -- `block-katex` and `block-mathjax`, byte for byte the
 * same in both before this existed (BLK-F4).
 *
 * The `.caption` rule here is only its centring: its colour and size come from `./styles.js`'s
 * `captionStyles`, which every captioned block shares and which deliberately leaves alignment out.
 * Adopt both, this one after it.
 */
export const figureStyles = css`
  :host {
    display: block;
  }

  /* -> The gap below the block. On this element rather than :host: see block-index. */
  .formula,
  .error {
    margin-bottom: 16px;
  }

  .formula {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .formula.is-left {
    align-items: flex-start;
  }

  /*
    A formula wider than the column scrolls rather than shrinks, the way a display equation in the
    text does. Shrinking is the wrong answer for something read symbol by symbol: a long derivation
    would end up a grey smear.
  */
  .drawing {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    /* -> Room for the scrollbar to appear without it sitting on the descenders */
    padding: 0.2em 0;
  }

  .caption {
    text-align: center;
  }
`

/**
 * The frame drawn around an embedded player or document (OpenProject #2876, `ui-iteration/blocks.md`
 * "Shared fragments" > "Embed frame") -- `block-youtube`, `block-vimeo`, `block-dailymotion`,
 * `block-m365-video`, `block-media-player`, `block-asciinema`, `block-pdf`, `block-map`,
 * `block-openapi`. The opposite case from `figureStyles` above: a diagram or formula figure carries
 * no frame at all, while these nine draw nothing BUT the frame around their embedded content.
 *
 * `.embed-frame` reuses the same generic `--block-border`/`--block-radius`/`--block-corner-marks`/
 * `--block-mark-color` set every themed block card already reads off `body` (`tailwind.css`,
 * OpenProject #2874/#2875) -- Ledger's square hairline with two corner marks, Cobalt's 8px
 * `overflow: hidden` card, in both light and dark, with no new token needed.
 *
 * `.embed-frame__play` is the lazy-load play affordance the mocks draw over a paused player. Its
 * Ledger/Cobalt shapes (56px square-vs-round) genuinely differ rather than sharing one token the way
 * the frame does, and expressing that difference needs either a dedicated token in `tailwind.css` (a
 * file this task does not own this round) or `:host-context(.body--cobalt)` (a pattern nothing in
 * `blocks/` uses today, unlike `:host([dark])`) -- so this class draws the Ledger take only
 * (`--block-radius`, square-cornered) for now; a Cobalt-specific round variant is a follow-up once a
 * block actually adopts this class. Neither class is imported by any block's `component.js` yet --
 * wiring one of the nine to adopt `.embed-frame` (and, for the four video providers, replacing
 * `./video-embed.js`'s own unbordered `.player`) is that block's own conversion task, the same
 * "tokens/fragment landed, block conversion follows" split OpenProject #2874/#2875 already used for
 * `tailwind.css` itself.
 */
export const embedFrameStyles = css`
  .embed-frame {
    position: relative;
    border: 1px solid var(--block-border);
    border-radius: var(--block-radius);
    overflow: hidden;
  }

  /* -> The two corner marks every themed block card draws -- "none" under Cobalt, whose frame is bounded by its own radius instead. */
  .embed-frame::before {
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

  .embed-frame__play {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border: 1px solid rgb(255 255 255 / 0.5);
    border-radius: var(--block-radius);
    background-color: transparent;
    color: #fff;
  }
`

/**
 * Why a block could not make anything of the source it was handed.
 *
 * Says what failed and repeats the renderer's own message, then -- when the source did NOT come out
 * of a fenced code block -- names the fence, because that is the answer nine times out of ten: an
 * unfenced body has been through markdown's typographer before the block ever sees it, so what
 * failed to parse is usually not what the author typed.
 *
 * @param {string} clause What failed and how, as it reads in the message: the whole clause that
 *   follows "This" -- `'formula could not be typeset'`, `'diagram could not be drawn'` -- not a bare
 *   verb.
 * @param {Error | unknown} err Whatever the renderer threw. Its `message` when it has one, otherwise
 *   the value itself.
 * @param {boolean} fenced Whether the source came out of a `<pre>` -- `readFencedSource`'s second
 *   return value (`./body.js`).
 * @returns {string}
 */
export function explainSourceFailure(clause, err, fenced) {
  const message = `This ${clause}: ${err?.message ?? err}`
  if (fenced) {
    return message
  }
  return `${message}\n\nThe source has to go inside a fenced code block, or markdown rewrites it before this block sees it.`
}
