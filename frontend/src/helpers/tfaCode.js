/**
 * Shape-matching for the two forms of code the 2FA login/setup endpoints accept: a 6-digit TOTP
 * code, and a recovery code.
 *
 * Recovery codes are generated server-side by `backend/helpers/recoveryCodes.ts` using Crockford's
 * base32 alphabet (digits plus letters, excluding the visually-ambiguous `I`/`L`/`O`/`U`) grouped
 * into four dash-separated blocks of four -- `XXXX-XXXX-XXXX-XXXX`. This mirrors that shape on the
 * client, matching the JSON Schema `pattern` the backend validates against
 * (`recoveryCodeDisplayPattern` in that same file), so a malformed code is rejected before a round
 * trip to the server rather than importing backend code across the workspace boundary.
 */

const SECURITY_CODE_PATTERN = /^[0-9]{6}$/

const RECOVERY_CODE_GROUP = '[0-9A-HJKMNPQRSTVWXYZ]{4}'
const RECOVERY_CODE_PATTERN = new RegExp(`^${RECOVERY_CODE_GROUP}(-${RECOVERY_CODE_GROUP}){3}$`)

/**
 * Reformats free-typed recovery code input into the canonical display shape as the user types:
 * uppercased, non-alphanumeric characters dropped, then redashed into groups of four. A character
 * outside the Crockford alphabet (`I`, `L`, `O`, `U`) is left in place rather than silently
 * dropped, so an unmistakably wrong character still shows up as a validation failure instead of
 * disappearing on its way to the server.
 *
 * @param {string} raw
 * @returns {string}
 */
export function formatRecoveryCodeInput(raw) {
  const stripped = (raw ?? '')
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
    .slice(0, 16)
  return stripped.replace(/(.{4})(?=.)/g, '$1-')
}

/**
 * Whether `code` is shaped like a valid submission for the given mode -- the same check the server
 * enforces via its JSON Schema `pattern` on `PUT /sites/:siteId/auth/tfa`, run client-side so a
 * malformed code is rejected before the request is sent.
 *
 * @param {string} code
 * @param {boolean} isRecoveryCode
 * @returns {boolean}
 */
export function isValidTfaCode(code, isRecoveryCode) {
  return isRecoveryCode
    ? RECOVERY_CODE_PATTERN.test(code ?? '')
    : SECURITY_CODE_PATTERN.test(code ?? '')
}
