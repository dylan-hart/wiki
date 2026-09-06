/**
 * The field rules the sign-in panel's forms share.
 *
 * `AuthLoginPanel.vue`'s login/forgot/reset/change-password screens and `AuthRegisterScreen.vue`'s
 * form ask the same questions of the same fields, and did so through identical rule arrays declared
 * once per screen's owning component. The sign-up form's two name halves are here for the same
 * reason, even though only that screen asks them today. Built as functions rather than exported
 * arrays because every message goes through the screen's own `t()`, and the verify rule has to read
 * whatever the password field holds at the moment it runs -- hence a getter rather than a value.
 *
 * `W*` form fields take a rule as `(value) => true | string`, where the string is what is shown.
 * Every function below takes the screen's `useI18n()` translator.
 */

/**
 * The sign-up form's first name (Feature #2608). Required, like the single name field it replaced:
 * an account has to be called something, and the display name derives from this half alone when
 * there is no surname.
 *
 * @param t The screen's `useI18n()` translator.
 */
export function firstNameRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingFirstName'),
    (val) => /^[^<>"]+$/.test(val) || t('auth.errors.invalidName')
  ]
}

/**
 * The sign-up form's last name. Deliberately optional where the first name is not -- a mononym has
 * no surname and nothing fabricates one -- so an empty value passes and only a value that is
 * actually there is checked for the characters a name refuses.
 *
 * @param t The screen's `useI18n()` translator.
 */
export function lastNameRules(t) {
  return [(val) => !val || /^[^<>"]+$/.test(val) || t('auth.errors.invalidName')]
}

/** @param t The screen's `useI18n()` translator. */
export function emailRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingEmail'),
    (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
  ]
}

/** @param t The screen's `useI18n()` translator. */
export function passwordRules(t) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingPassword'),
    (val) => val.length >= 8 || t('auth.errors.passwordTooShort')
  ]
}

/**
 * @param t The screen's `useI18n()` translator.
 * @param getPassword Reads the password this confirmation has to match, at validation time.
 */
export function passwordVerifyRules(t, getPassword) {
  return [
    (val) => val.length > 0 || t('auth.errors.missingVerifyPassword'),
    (val) => val === getPassword() || t('auth.errors.passwordsNotMatch')
  ]
}
