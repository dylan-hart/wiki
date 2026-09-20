/**
 * The field rules the sign-in panel's forms share. Functions rather than exported arrays because
 * every message goes through the screen's own `t()`, and the verify rule has to read whatever the
 * password field holds at the moment it runs -- hence a getter rather than a value.
 *
 * `W*` form fields take a rule as `(value) => true | string`, where the string is what is shown.
 * Every function below takes the screen's `useI18n()` translator.
 */

/** Required: an account has to be called something, and a mononym's display name is this half. */
export function firstNameRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingFirstName'),
    (val) => /^[^<>"]+$/.test(val) || t('auth.errors.invalidName')
  ]
}

/** Optional where the first name is not: a mononym has no surname and nothing fabricates one. */
export function lastNameRules(t) {
  return [(val) => !val || /^[^<>"]+$/.test(val) || t('auth.errors.invalidName')]
}

export function emailRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingEmail'),
    (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
  ]
}

export function passwordRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingPassword'),
    (val) => val.length >= 8 || t('auth.errors.passwordTooShort')
  ]
}

export function passwordVerifyRules(t, getPassword) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingVerifyPassword'),
    (val) => val === getPassword() || t('auth.errors.passwordsNotMatch')
  ]
}
