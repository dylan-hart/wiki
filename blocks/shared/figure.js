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
