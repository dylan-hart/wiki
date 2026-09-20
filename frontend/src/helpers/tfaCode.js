/**
 * Recovery codes are generated server-side by `backend/helpers/recoveryCodes.ts` using Crockford's
 * base32 alphabet (digits plus letters, excluding the visually-ambiguous `I`/`L`/`O`/`U`) grouped
 * into four dash-separated blocks of four. These patterns mirror the JSON Schema `pattern` the
 * backend validates against (`recoveryCodeDisplayPattern` in that same file) -- duplicated rather
 * than imported across the workspace boundary, so a malformed code is rejected before a round trip.
 */

const SECURITY_CODE_PATTERN = /^[0-9]{6}$/

const RECOVERY_CODE_GROUP = '[0-9A-HJKMNPQRSTVWXYZ]{4}'
const RECOVERY_CODE_PATTERN = new RegExp(`^${RECOVERY_CODE_GROUP}(-${RECOVERY_CODE_GROUP}){3}$`)

/**
 * A character outside the Crockford alphabet (`I`, `L`, `O`, `U`) is left in place rather than
 * silently dropped, so an unmistakably wrong character still shows up as a validation failure
 * instead of disappearing on its way to the server.
 */
export function formatRecoveryCodeInput(raw) {
  const stripped = (raw ?? '')
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
    .slice(0, 16)
  return stripped.replace(/(.{4})(?=.)/g, '$1-')
}

export function isValidTfaCode(code, isRecoveryCode) {
  return isRecoveryCode
    ? RECOVERY_CODE_PATTERN.test(code ?? '')
    : SECURITY_CODE_PATTERN.test(code ?? '')
}
