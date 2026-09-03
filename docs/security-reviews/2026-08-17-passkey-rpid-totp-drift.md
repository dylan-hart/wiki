# Security review: WebAuthn origin/RP-ID and TOTP drift window vs. multi-site + reverse-proxy hostnames

Task 435, feature 356 ("2FA & Passkey Hardening, Recovery, and Admin Visibility"). Scope: does
`resolveOrigin()` / the `rpID` / `expectedOrigin` / `expectedRPID` wiring in
`backend/models/passkeys.ts` hold up under both `security.trustProxy` settings and Wiki.js's
single-hostname-per-site model, and is the TOTP drift window in `backend/helpers/totp.ts` adequate.

**Verdict: no exploitable gap found.** One diagnosability fix shipped (`ERR_PK_ORIGIN_MISMATCH`,
below). The TOTP drift window is a deliberate, justified tightening relative to Wiki.js 2.5.x's own
default and is recorded in `docs/variances.md` rather than left as a silent behavior change.

## How the RP ID and origin actually get set

Every passkey ceremony (`POST /users/profile/passkeys/challenge`, `PUT /sites/:siteId/auth/passkey/*`
in `backend/api/users/profile.ts` and `backend/api/auth/site.ts`) calls into `passkeys.ts` with two values
taken straight off the request:

- `hostname: req.hostname` — becomes the WebAuthn `rpID` verbatim (`startRegistration`/`startLogin`).
- `origin: req.headers.origin` — fed to `resolveOrigin(origin, hostname)`, which produces
  `expectedOrigin`.

`resolveOrigin()` (now exported, see `backend/models/passkeys.test.ts` for the unit coverage this
review added) does three things, in order:

1. No `Origin` header → assumes `https://${hostname}`. Documented as "not a browser doing a WebAuthn
   ceremony... so the canonical https origin is assumed." A real browser WebAuthn ceremony always goes
   through `fetch`, which sends `Origin` on same-origin POSTs, so this path is for non-browser API
   clients, not the ceremony itself.
2. **`parsed.hostname !== hostname` → reject.** This is the actual security boundary: whatever
   `hostname` the server computed, the browser's own `Origin` header has to agree with it byte-for-byte
   before a ceremony proceeds.
3. `parsed.protocol !== 'https:'` (outside the `localhost`/`127.0.0.1`/`[::1]` exceptions) → reject.

`finalizeRegistration()` / `verifyLogin()` then pass `pending.rpId` and `pending.origin` — the exact
values frozen into the session at step 1, not recomputed — into `@simplewebauthn/server`'s
`expectedRPID` / `expectedOrigin`, which cryptographically verifies the authenticator's signed
response against them. This is the part that can't be forged by manipulating headers alone: it
requires a real browser to have actually run `navigator.credentials.create()`/`get()` bound to that
exact origin, which the browser's own WebAuthn implementation enforces independent of anything this
server tells the browser about its own hostname.

## `security.trustProxy: false` (default)

`req.hostname` is Fastify's own parse of the `Host` header, unmodified by anything this app does.
Behind a real reverse proxy that does **not** forward the original `Host` (e.g. a `proxy_pass` without
`proxy_set_header Host $host;`, or a load balancer that substitutes an internal service name), this
degrades to whatever the proxy sent upstream — the proxy's own address, not the public one.

This does **not** silently break passkeys into an insecure state. A real browser at the real public
hostname still sends the real `Origin` header for that hostname; `resolveOrigin()`'s step 2 above
catches the disagreement and rejects the ceremony outright (previously `ERR_PK_INSECURE_ORIGIN` for
this case too — see the fix below). The failure mode is loud and total (passkeys stop working
instance-wide the moment `req.hostname` degrades) rather than quiet or partial, which is the right
shape of failure for a security-sensitive ceremony, but it was hard to tell apart from an actual
TLS/HTTPS problem — see "Fix shipped" below.

## `security.trustProxy: true`

`backend/index.ts` (~line 262) passes this straight to Fastify's own `trustProxy` option. Fastify's
implementation (`fastify/lib/request.js`, `getTrustProxyFn`) treats the boolean `true` as
"trust everything":

```js
if (tp === true) {
  // Support trusting everything
  return function () { return true }
}
```

i.e. `X-Forwarded-Host` is honored from **any** source, with no IP/CIDR allowlist — Wiki.js's own
`SecurityConfig` schema (`backend/api/schemas/security.ts`) only exposes `trustProxy` as a plain
boolean, never as the IP/CIDR/function form Fastify also accepts. So: if the Node process is reachable
by anyone other than the legitimate reverse proxy — the proxy is on a shared network segment, a
firewall rule is missing, a cloud load balancer route bypasses it — an attacker can set
`req.hostname` (and hence the `rpID` the server *thinks* it's operating as) to whatever they like by
sending their own `X-Forwarded-Host`.

**This does not, by itself, let an attacker register or authenticate a passkey against a real site's
RP ID.** Completing a WebAuthn ceremony requires a real browser, at the real origin, running the real
`navigator.credentials` API — that binding is enforced client-side by the browser and re-verified
cryptographically server-side by `@simplewebauthn/server` against `pending.rpId`/`pending.origin`
frozen at ceremony-start. Raw HTTP header manipulation with no matching real browser ceremony produces
no valid attestation/assertion to submit. The scenario where header trust actually matters is a
`trustProxy: true` deployment where the proxy itself is misconfigured to pass through a
client-supplied `X-Forwarded-Host` instead of overwriting it (or the backend is directly reachable) —
and even then, per the origin-hostname check above, this fails closed (`ERR_PK_ORIGIN_MISMATCH`) the
moment a real browser's `Origin` disagrees with whatever bogus hostname the header trickery produced.

This is not a passkey-specific gap: `req.ip`/`req.hostname` trust under `trustProxy: true` is a
system-wide deployment assumption already relied on elsewhere (`helpers/rateLimit.ts`'s per-client-IP
auth throttling explicitly documents the same dependency; site resolution, CORS reflection, and
audit logging all read the same trusted-or-not hostname/IP). Fixing it narrowly inside
`passkeys.ts` would leave the identical exposure in every other consumer, so it isn't treated as a
`passkeys.ts` bug. The correct mitigation is operational — never expose the Node process directly,
and configure the real proxy to overwrite (not merge/append) `X-Forwarded-Host` — standard guidance
for `trustProxy: true` (or Express's identical `trust proxy: true`) in any framework built on it.

## Multi-site / no-aliases model

`hostname === '*'` is rejected explicitly (`ERR_PK_HOSTNAME_MISSING`). `req.hostname` can't literally
be the string `*` from any real client — this guards the case where it somehow is (a deliberately
crafted `Host: *`), so that value can never collide with `WIKI.sitesMappings['*']`, the sentinel key
the default/wildcard site is seeded under (`models/sites.ts#init`). Since a WebAuthn `rpId` of `*` is
not a valid registrable domain in the first place, no real browser ceremony could exploit the absence
of this check either — it's a clean input-sanity rejection, not a patch for a reachable exploit.

`startRegistration`/`startLogin` resolve `WIKI.models.sites.getSiteByHostname({ hostname })` without
`strict: true`, so an unmapped hostname falls back to the wildcard site rather than `null`. That
matches every other hostname→site resolution in this codebase (`controllers/site.ts`,
`controllers/files.ts`, `api/users/profile.ts`'s own TFA-enforcement lookup) — it is the app's normal
"this hostname isn't explicitly configured, serve the default site" behavior, not something
passkeys.ts invented. The resolved `site` is used only for the cosmetic `rpName` and to tag
`pending.siteId`/the stored credential's `siteId` for the profile/admin passkey list — it is not a
second RP-ID source and does not affect which RP ID the credential is bound to. Two distinct site
hostnames can never collapse onto one shared RP ID through this path, because the RP ID is always the
literal (trusted-per-`trustProxy` above) `req.hostname`, and the origin-hostname equality check
enforces that whatever that value is, the real browser session agrees with it.

## Fix shipped: `ERR_PK_ORIGIN_MISMATCH`

`resolveOrigin()` previously threw the same `ERR_PK_INSECURE_ORIGIN` for two different causes: a
non-HTTPS origin, and an origin whose hostname disagrees with the request (the exact shape a
`trustProxy` misconfiguration or a reverse proxy that isn't forwarding `Host` produces). The shared
locale string — "Passkeys require a secure (HTTPS) connection to this site." — actively misleads an
admin debugging the second case into suspecting a TLS problem that doesn't exist.

Split into two error codes. `ERR_PK_INSECURE_ORIGIN` keeps its meaning (protocol / unparseable
origin); the new `ERR_PK_ORIGIN_MISMATCH` covers the hostname-disagreement case, with locale text that
points at the actual likely cause:

> This request's origin does not match the site's hostname. If this instance is behind a reverse
> proxy, check that it forwards the real Host header and, if "Trust X-Forwarded-* Proxy Headers" is
> enabled, that only the proxy can reach this server directly.

Security behavior is unchanged — both cases still reject the ceremony — this only makes the failure
diagnosable. See `backend/models/passkeys.ts` (`resolveOrigin`) and
`backend/models/passkeys.test.ts` for the unit coverage.

## TOTP drift window

`backend/helpers/totp.ts` accepts a code from `allowedDrift = 1` step either side of the current
30-second window — a 90-second total acceptance window — and the file's own header comment already
states the RFC 6238 parameters (including this one) are "not configurable on purpose."

Compared against Wiki.js 2.5.x's own baseline (`node-2fa@1.1.2`, used as `tfa.verifyToken(secret,
code)` with no explicit `window` argument in `server/models/users.js`): `node-2fa`'s `verifyToken`
defaults `window` to `4` when omitted, and passes it straight through to `notp.totp.verify({ window,
time: 30 })`, whose `window` is the same "±N steps" semantic used here. So 2.5.x's actual default
was **±4 steps — a ~270-second (4.5-minute) acceptance window**, three times wider each direction than
this codebase's `allowedDrift = 1`.

This is a real, intentional behavior change from the 2.5.x baseline, not an oversight:

- ±30s (this repo) is the conventional secure default for TOTP verifiers — it's the window OWASP's
  MFA guidance and most current TOTP libraries (e.g. `pyotp`'s recommended `valid_window=1`) treat as
  standard, and it's tight enough that a leaked/observed code has a narrow replay window.
- ±120s (2.5.x's actual default) accepts 9 distinct valid codes at any instant instead of 3, which is
  unusually generous — plausibly a legacy default nobody revisited, not a deliberate security choice
  in the 2.5.x codebase itself.
- A typical device's clock drift (NTP-synced, which is the overwhelming majority of phones and
  computers today) is on the order of seconds, not tens of seconds — ±30s already covers ordinary
  drift plus the time a user takes to type six digits.

**Conclusion: ±30s is adequate, and deliberately tighter than 2.5.x's default is correct, not a
regression.** Per `CLAUDE.md`, this branch owes 2.5.x no compatibility, so the change needs no shim —
just a recorded reason, which is what this review is. Not making it admin-configurable is also
deliberate: `totp.ts`'s stated design is that these are exactly what an `otpauth://` URI implies when
it omits parameters, which every authenticator app already assumes; a per-instance override would let
an admin silently widen the acceptance window (and therefore the replay surface) with no corresponding
change on the authenticator side to justify it. If real-world support tickets ever show ±30s being too
tight for a specific deployment, that's the trigger to revisit — not a hypothetical now.

Recorded in `docs/variances.md` under "TOTP drift window intentionally tighter than 2.5.x baseline."

## Residual recommendations (not implemented here, out of scope for this task)

- Consider documenting, in the admin Security settings page copy for "Trust X-Forwarded-* Proxy
  Headers," the operational requirement this review reaffirms: only enable it when the reverse proxy
  is the sole path to this server, and confirm the proxy overwrites rather than appends
  `X-Forwarded-Host`. This is a pure documentation/UX change, not a passkey-specific code fix, and
  applies to every `trustProxy`-consuming feature (rate limiting, site resolution, CORS), not just
  passkeys — a good candidate for its own small task rather than folding into this one.
