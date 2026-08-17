# Variances

Genuine, justified deviations from spec. An entry is removed once resolved — this file is not a
changelog.

## TOTP drift window intentionally tighter than 2.5.x baseline (task 435, feature 356)

`backend/helpers/totp.ts` accepts a code within `allowedDrift = 1` step of the current 30-second
window (±30s, 90s total). Wiki.js 2.5.x's own default was wider: `node-2fa@1.1.2`'s `verifyToken()`
defaults its `window` argument to `4` when the caller omits it, and 2.5.x's
`server/models/users.js` calls `tfa.verifyToken(this.tfaSecret, code)` with no third argument — so
the 2.5.x baseline actually accepted ±4 steps, a ~270-second (4.5-minute) window, three times wider
each direction than this codebase.

This is deliberate, not a regression: ±30s is the conventional secure TOTP default (matches OWASP's
MFA guidance and most current libraries' recommended window), narrows the replay surface a leaked
code has, and comfortably covers realistic clock drift for NTP-synced devices. The wider 2.5.x
default reads as an unrevisited legacy value rather than a considered choice. `totp.ts`'s own header
comment already documents that these RFC 6238 parameters — including this one — are "not
configurable on purpose," so no per-instance override is offered either: widening it would let an
admin silently enlarge the replay window with nothing on the authenticator side to justify it.

Full analysis: `docs/security-reviews/2026-08-17-passkey-rpid-totp-drift.md`. Resolution: none
needed — this is the intended, permanent behavior. Revisit only if real-world deployments show ±30s
is too tight (e.g. a pattern of legitimate users failing TOTP due to drift), at which point this
entry should be replaced with whatever the new decision is, not just deleted.
