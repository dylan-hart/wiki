/**
 * Validation rules for the name/email a guest (unauthenticated) visitor supplies when they act on a
 * page without an account -- suggesting an edit (`SuggestionGuestDialog.vue`) and posting a comment
 * (`CommentComposer.vue`) both ask for exactly the same two fields, and used to each type their own
 * copy of the same "is this an email address" regex.
 *
 * Shaped as the `rules` convention already in the codebase -- `Array<(value) => true | string>`, fed
 * straight into a `<w-input :rules>` -- rather than a single validator function, so both call sites
 * keep using `w-input`'s own per-field error display with no translation layer in between.
 */

/**
 * @param {(key: string) => string} t vue-i18n's `t`, so the message tracks the active locale
 * @returns {Array<(value: string) => true | string>}
 */
export function guestNameRules(t) {
  return [(val) => (val ?? '').trim().length > 0 || t('auth.errors.missingName')]
}

/**
 * @param {(key: string) => string} t vue-i18n's `t`, so the message tracks the active locale
 * @returns {Array<(value: string) => true | string>}
 */
export function guestEmailRules(t) {
  return [
    (val) => (val ?? '').trim().length > 0 || t('auth.errors.missingEmail'),
    (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
  ]
}
