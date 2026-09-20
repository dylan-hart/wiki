/**
 * Account passwords come from the browser's CSPRNG (`crypto.getRandomValues()`), never
 * `Math.random()` -- which es-toolkit's `sample`/`sampleSize` bottoms out at. V8's `Math.random()`
 * is a xorshift128+ PRNG whose internal state is recoverable from a handful of observed outputs,
 * not an acceptable source for a password that gets written down and mailed to a new user
 * (CWE-338).
 */

/**
 * The default alphabet: letters, digits and a handful of symbols, with the characters a reader
 * confuses with each other (`i`/`l`/`I`/`1`, `o`/`O`/`0`, `g`/`q`) left out, since the generated
 * password is revealed and typed back in.
 */
export const PASSWORD_CHARSET = 'abcdefghkmnpqrstuvwxyzABCDEFHJKLMNPQRSTUVWXYZ23456789_*=?#!()+'

/**
 * Letters and digits only, again minus the easily-confused ones (`O`/`0`, `I`/`1`/`l`). A new
 * account's password draws its FIRST character from this and the remainder from this plus symbols,
 * so it never opens with a symbol -- the deliberate difference from `PASSWORD_CHARSET` above, and
 * why both live here rather than as two look-alike literals in two dialogs.
 */
export const PASSWORD_CHARSET_UNAMBIGUOUS =
  'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// 2**32, the range of a Uint32 draw. A draw at or above the largest multiple of `alphabet.length`
// below it is rejected and redrawn rather than reduced with `%`, which is what avoids modulo bias
// for an alphabet length that doesn't evenly divide the range.
const UINT32_RANGE = 0x1_0000_0000

export function randomPassword(length, alphabet) {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('randomPassword: length must be a non-negative integer')
  }
  if (!alphabet || alphabet.length === 0) {
    throw new Error('randomPassword: alphabet must not be empty')
  }

  const threshold = UINT32_RANGE - (UINT32_RANGE % alphabet.length)
  const chars = []
  // Batched because rejection sampling leaves the number of draws unknown upfront, and redrawing
  // one Uint32 at a time would be wasteful for a mostly-rejecting alphabet length.
  let batch = new Uint32Array(length)
  let batchIndex = batch.length

  while (chars.length < length) {
    if (batchIndex >= batch.length) {
      crypto.getRandomValues(batch)
      batchIndex = 0
    }
    const value = batch[batchIndex++]
    if (value < threshold) {
      chars.push(alphabet[value % alphabet.length])
    }
  }

  return chars.join('')
}
