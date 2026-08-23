import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'

/**
 * Built once per process and reused by every call site, matching the bundled English-only behavior
 * the replaced `zxcvbn` package had no configuration for in the first place.
 */
const zxcvbn = new ZxcvbnFactory({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations
})

/**
 * A password's strength score, 0 (weakest) through 4 (strongest) — the same scale the replaced
 * `zxcvbn` package returned as `.score`.
 * @param {string} password
 * @returns {number}
 */
export function passwordStrengthScore(password) {
  return zxcvbn.check(password).score
}
