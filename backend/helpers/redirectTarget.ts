/**
 * The one rule every redirect/navigation sink in this codebase applies to a stored or caller-supplied
 * destination, so a scheme like `javascript:` never reaches a browser `href`/`Location` header.
 *
 * Mirrors the rule `frontend/src/helpers/pageRedirect.js#isFollowable` already applies to a page
 * redirection's own target: a rooted path that does not begin `//` (or `/\`, which every browser
 * normalizes to `//` before resolving it, turning it into the same protocol-relative address) is
 * always safe, and beyond that only a complete, parseable URL whose scheme is on the allowed list —
 * `http:`/`https:` unless a caller widens it — is accepted. Everything else, `javascript:`, `data:`,
 * a bare unparseable string, is refused.
 *
 * Deliberately **parses** the candidate with `URL` rather than pattern-matching the scheme prefix:
 * `/^[a-z][a-z0-9+.-]*:\/\//i` — the check this replaces at `frontend/src/App.vue`'s old logout
 * handler — is satisfied by `javascript://%0aalert(1)`, because the `//` reads as a JS line comment
 * and the decoded newline ends it before `alert(1)` runs. `URL` resolves the real scheme regardless
 * of what a comment inside the rest of the string looks like.
 */

export interface RedirectTargetOptions {
  /**
   * Whether a complete absolute URL is accepted at all, in addition to a same-origin rooted path.
   * Defaults to `true`. Set to `false` to restrict a sink to this wiki's own origin — this is the
   * on/off switch `security.disallowOpenRedirect` drives for the login/logout/authorize redirect
   * sinks (see `backend/models/security.ts`); a caller that always means to allow leaving the site —
   * a navigation item's target, a page relation — leaves this at its default.
   */
  allowAbsolute?: boolean
  /**
   * Schemes (as `URL#protocol` renders them, trailing colon included) an absolute URL may use.
   * Defaults to `http:`/`https:` only. A navigation item target additionally allows `mailto:`/`tel:`,
   * which are legitimate destinations for a menu link and carry no script-execution risk.
   */
  allowedProtocols?: readonly string[]
}

const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:'] as const

/**
 * Whether `value` is safe to hand to a browser as a redirect target or a link `href`.
 *
 * @param value The candidate target — typically author- or attacker-supplied, so this never trusts
 *   its shape going in.
 * @param options See `RedirectTargetOptions`.
 */
export function isFollowableRedirectTarget(
  value: unknown,
  { allowAbsolute = true, allowedProtocols = DEFAULT_ALLOWED_PROTOCOLS }: RedirectTargetOptions = {}
): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (trimmed.length < 1) {
    return false
  }
  // -> A rooted path is always same-origin and never carries a scheme of its own -- except when it
  //    starts `//` (protocol-relative, resolved by a browser as an absolute address on whatever host
  //    follows) or `/\` (which a browser normalizes to `//` before resolving it the same way).
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return true
  }
  if (!allowAbsolute) {
    return false
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  return allowedProtocols.includes(url.protocol)
}

/**
 * Whether `WIKI.config.security.disallowOpenRedirect` permits an absolute (off-site) redirect target
 * right now — the shared on/off switch for the login/logout/authorize sinks. Off by inversion: the
 * setting is phrased as "disallow", `isFollowableRedirectTarget`'s option as "allow".
 */
export function absoluteRedirectsAllowed(): boolean {
  return WIKI.config.security?.disallowOpenRedirect === false
}
