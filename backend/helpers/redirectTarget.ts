/**
 * The one rule every redirect/navigation sink applies to a stored or caller-supplied destination,
 * so a scheme like `javascript:` never reaches a browser `href`/`Location` header. Mirrored by
 * `frontend/src/helpers/pageRedirect.js#isFollowableRedirectTarget` — keep the two in sync.
 *
 * Parses the candidate with `URL` rather than pattern-matching a `scheme://` prefix: such a regex
 * accepts `javascript://%0aalert(1)`, where `//` opens a JS line comment and the decoded newline
 * ends it before `alert(1)` runs.
 */

export interface RedirectTargetOptions {
  /**
   * `false` restricts a sink to this wiki's own origin; `security.disallowOpenRedirect` drives it
   * for the login/logout/authorize sinks (see `absoluteRedirectsAllowed`).
   */
  allowAbsolute?: boolean
  /** As `URL#protocol` renders them, trailing colon included. Defaults to `http:`/`https:`. */
  allowedProtocols?: readonly string[]
}

const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:'] as const

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
  // -> A rooted path is same-origin unless it starts `//` (protocol-relative) or `/\`, which
  //    browsers normalize to `//`.
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
 * The shared switch for the login/logout/authorize sinks, inverted: the setting says "disallow",
 * `allowAbsolute` says "allow". An unset value reads as "allowed", but only a stub `CARDINAL.config`
 * leaves it unset: `base.yml` defaults it to `true`.
 */
export function absoluteRedirectsAllowed(): boolean {
  return CARDINAL.config.security?.disallowOpenRedirect !== true
}
