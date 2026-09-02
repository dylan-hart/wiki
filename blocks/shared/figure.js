/**
 * The captioned-figure blocks' shared pieces -- a formula, a diagram, a drawing, each drawn from
 * source read out of the block's own body.
 */

/**
 * Why a block could not make anything of the source it was handed.
 *
 * Says what failed and repeats the renderer's own message, then -- when the source did NOT come out
 * of a fenced code block -- names the fence, because that is the answer nine times out of ten: an
 * unfenced body has been through markdown's typographer before the block ever sees it, so what
 * failed to parse is usually not what the author typed.
 *
 * @param {string} verb What failed and how, as it reads in the message: the clause that follows
 *   "This". `'formula could not be typeset'`, `'diagram could not be drawn'`.
 * @param {Error | unknown} err Whatever the renderer threw. Its `message` when it has one, otherwise
 *   the value itself.
 * @param {boolean} fenced Whether the source came out of a `<pre>` -- `readFencedSource`'s second
 *   return value (`./body.js`).
 * @returns {string}
 */
export function explainSourceFailure(verb, err, fenced) {
  const message = `This ${verb}: ${err?.message ?? err}`
  if (fenced) {
    return message
  }
  return `${message}\n\nThe source has to go inside a fenced code block, or markdown rewrites it before this block sees it.`
}
