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

/** One entry per score, 0 through 4. */
const BADGES = [
  { color: 'negative', label: 'common.password.weak' },
  { color: 'deep-orange-7', label: 'common.password.poor' },
  { color: 'purple-7', label: 'common.password.average' },
  { color: 'blue-7', label: 'common.password.good' },
  { color: 'green-7', label: 'common.password.strong' }
]

/**
 * How to draw a password's strength next to the field it was typed into: a theme colour and a
 * translated one-word verdict.
 *
 * Anything shorter than 8 characters is called weak regardless of what it scores — that is the
 * minimum every password form in the app enforces, so a short password is refused on submit no
 * matter how unguessable zxcvbn finds it, and the badge should not encourage one.
 *
 * `t` is passed in rather than resolved here: this is a plain helper, not a composable, and
 * `useI18n()` only works inside a component's own setup.
 *
 * @param {string} password
 * @param {(key: string) => string} t The caller's `useI18n()` translator.
 * @returns {{ color: string, label: string }}
 */
export function passwordStrengthBadge(password, t) {
  const badge =
    password.length < 8 ? BADGES[0] : (BADGES[passwordStrengthScore(password)] ?? BADGES[0])
  return { color: badge.color, label: t(badge.label) }
}
