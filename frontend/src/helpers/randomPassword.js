/**
 * Generates account passwords from the browser's CSPRNG (`crypto.getRandomValues()`), not
 * `Math.random()`. es-toolkit's `sample`/`sampleSize` -- what `randomizePassword()` in
 * `UserCreateDialog.vue`, `UserChangePwdDialog.vue` and `ChangePwdDialog.vue` used to call --
 * bottoms out at `array/sampleSize` -> `math/randomInt` -> `math/random` -> `Math.random()`.
 * V8's `Math.random()` is a xorshift128+ PRNG whose internal state is recoverable from a handful
 * of observed outputs; that is not an acceptable source for a password that gets written down and
 * mailed to a new user (CWE-338).
 */

// Largest multiple of 2**32 that still fits a Uint32 draw. A draw at or above this threshold is
// rejected and redrawn rather than reduced with `% alphabet.length`, which is what avoids modulo
// bias for an alphabet length that doesn't evenly divide 2**32 (true for every alphabet these
// dialogs use).
const UINT32_RANGE = 0x1_0000_0000

/**
 * Returns a `length`-character string drawn uniformly, with replacement, from `alphabet`, using
 * `crypto.getRandomValues()` with rejection sampling.
 *
 * @param {number} length
 * @param {string} alphabet
 * @returns {string}
 */
export function randomPassword(length, alphabet) {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('randomPassword: length must be a non-negative integer')
  }
  if (!alphabet || alphabet.length === 0) {
    throw new Error('randomPassword: alphabet must not be empty')
  }

  const threshold = UINT32_RANGE - (UINT32_RANGE % alphabet.length)
  const chars = []
  // Draw in batches: rejection sampling means the exact number of draws needed isn't known
  // upfront, but redrawing one Uint32 at a time would be wasteful for a mostly-rejecting
  // alphabet length, so a batch is refilled whenever it runs out.
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
