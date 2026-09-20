/**
 * Shaped as the codebase's `rules` convention -- `Array<(value) => true | string>`, fed straight
 * into `<w-input :rules>` -- rather than one validator function, so call sites keep `w-input`'s own
 * per-field error display with no translation layer in between.
 */

/**
 * @param {(key: string) => string} t
 * @returns {Array<(value: string) => true | string>}
 */
export function guestNameRules(t) {
  return [(val) => (val ?? '').trim().length > 0 || t('auth.errors.missingName')]
}

/**
 * @param {(key: string) => string} t
 * @returns {Array<(value: string) => true | string>}
 */
export function guestEmailRules(t) {
  return [
    (val) => (val ?? '').trim().length > 0 || t('auth.errors.missingEmail'),
    (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
  ]
}
