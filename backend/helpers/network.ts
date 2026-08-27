import net from 'node:net'

/**
 * Whether an IP address (v4 or v6 literal) falls in a private, loopback, link-local, or otherwise
 * non-public range.
 *
 * Written for `models/liveData.ts`'s `block-live-data` resolver (OpenProject #868), and framed
 * generally enough for any future server-side fetch driven by author-supplied input: without this
 * check, anyone holding `write:pages` — a much lower bar than the network access this would hand
 * out — could point the block at a cloud metadata endpoint (`169.254.169.254`), a loopback admin
 * panel, or any other address a plain internet client could never have reached, and have the wiki
 * server fetch it on their behalf (SSRF).
 *
 * @param address A literal IP address, brackets already stripped for IPv6 (see `net.isIP`'s own
 *   input expectations). A hostname that is not an IP literal returns `false` here — callers resolve
 *   DNS first and check every address it comes back with, since the hostname itself carries no
 *   routability information on its own.
 */
export function isPrivateAddress(address: string): boolean {
  const type = net.isIP(address)
  if (type === 4) {
    return isPrivateIPv4(address)
  }
  if (type === 6) {
    return isPrivateIPv6(address)
  }
  return false
}

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return (
    a === 0 || // 0.0.0.0/8 -- "this network"
    a === 10 || // 10.0.0.0/8 -- RFC 1918
    a === 127 || // 127.0.0.0/8 -- loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 -- carrier-grade NAT
    (a === 169 && b === 254) || // 169.254.0.0/16 -- link-local; cloud metadata endpoints live here
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 -- RFC 1918
    (a === 192 && b === 168) // 192.168.0.0/16 -- RFC 1918
  )
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::') {
    return true
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) -- recurse on the embedded address
  // rather than special-casing it, so a mapped metadata-endpoint address is still caught.
  const mapped = normalized.match(/^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    return isPrivateIPv4(mapped[2])
  }
  const firstGroup = normalized.split(':')[0]
  return (
    ['fe8', 'fe9', 'fea', 'feb'].some((prefix) => firstGroup.startsWith(prefix)) || // fe80::/10
    firstGroup.startsWith('fc') || // fc00::/7 -- unique local
    firstGroup.startsWith('fd')
  )
}

/**
 * A DNS label: 1-63 chars, alphanumeric, hyphens allowed except at either end. Both cases are spelled
 * out explicitly (rather than relying on a regex `i` flag) so this same source string can be embedded
 * directly as a JSON Schema `pattern` -- Ajv applies a schema's `pattern` with no flags, so a
 * case-insensitive source only works if it never needed the flag to begin with.
 */
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const DOMAIN_HOSTNAME = `${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*`
/**
 * A loose IPv6 literal, `[`/`]`-bracketed: hex groups separated by colons, `::` collapse included.
 * Deliberately not a fully RFC 4291-compliant pattern -- the actual enforcement of "does this
 * credential's secret get sent here" is `originMatchesAllowlist`'s exact host+port comparison at
 * resolve time; this only guards against an admin fat-fingering the syntax the schema pattern
 * accepts, so a slightly permissive match costs nothing a strict one would have caught anyway.
 *
 * The brackets are required, not optional: `URL.prototype.hostname` for an IPv6-literal authority
 * always carries them (`new URL('http://[::1]/').hostname === '[::1]'`), and matching happens
 * against that same rendering -- an unbracketed entry would validate here but could then never
 * actually match at resolve time, silently making every IPv6 allowlist entry unusable (OpenProject
 * #1099 follow-up, carried forward into the origin+prefix shape).
 */
const DOMAIN_IPV6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'

/**
 * The regex source for one `allowedOrigins` entry: an `http:`/`https:` origin (hostname or bracketed
 * IPv6 literal, optional port) plus an optional path prefix -- no query string, no fragment, since
 * neither one is ever meaningful as part of a *prefix*. `https://api.example.com`, `https://api
 * .example.com:8443/v1` and `https://api.example.com/v1/reports` are all valid entries;
 * `api.example.com` (no scheme -- what the old hostname-only allowlist stored) and
 * `https://api.example.com/v1?x=1` (a query string) are not.
 *
 * Kept as a string (not just the compiled `ORIGIN_PREFIX_PATTERN` below) specifically so
 * `api/blockCredentials.ts` can splice it straight into the JSON Schema `pattern` for
 * `allowedOrigins` items -- the backend route and this helper's own `isValidOriginPrefixPattern`
 * share one definition of "valid" rather than risking two that quietly drift apart.
 */
export const ORIGIN_PREFIX_PATTERN_SOURCE = `^https?://(?:${DOMAIN_HOSTNAME}|${DOMAIN_IPV6})(?::[0-9]{1,5})?(?:/[^?#]*)?$`

const ORIGIN_PREFIX_PATTERN = new RegExp(ORIGIN_PREFIX_PATTERN_SOURCE)

/**
 * Whether `value` is syntactically a valid `allowedOrigins` entry -- the same shape
 * `originMatchesAllowlist` actually matches against: `http:`/`https:`, a hostname or bracketed IPv6
 * literal, an optional port, and an optional path prefix with no query or fragment. Used by both the
 * block-credential route schema and (mirrored, since `frontend/` cannot import from `backend/` --
 * see root `CLAUDE.md`'s workspace layout) `frontend/src/helpers/originPattern.js`'s copy for
 * `BlockCredentialDialog.vue`'s inline validation.
 *
 * Deliberately narrower than what `new URL()` itself would accept: no userinfo (`user:pass@host`),
 * since that has no business in a stored allowlist entry and `URL`'s own parser would silently
 * accept and discard it.
 */
export function isValidOriginPrefixPattern(value: string): boolean {
  if (!ORIGIN_PREFIX_PATTERN.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * Whether `url` falls within any entry of `allowedOrigins` -- the enforcement half of the
 * per-credential origin+path-prefix allowlist (OpenProject #2195/#2198). An empty list matches
 * nothing: `models/blockCredentials.ts` requires at least one origin at creation time specifically
 * so this function is never the only thing standing between "credential exists" and "credential
 * unusable."
 *
 * A pattern pins **scheme, host and port** (via `URL#protocol`/`#host` equality -- `#host` already
 * includes the port) and, independently, a **path prefix**: an entry with no path (or a bare `/`)
 * matches every path on that origin, while `https://api.example.com/v1` matches `/v1` and
 * `/v1/reports` but not `/v1-legacy` (the trailing-slash-or-exact-match boundary check below is what
 * keeps a prefix from accidentally matching an unrelated sibling path). `models/liveData.ts#resolve()`
 * separately refuses any credentialed request whose own scheme is not `https:` -- this function does
 * not special-case scheme beyond the plain equality check, since a stored `http:` entry can never
 * match a request forced to `https:` anyway.
 *
 * @param allowedOrigins Every entry is assumed already validated by
 *   {@link isValidOriginPrefixPattern} (`models/blockCredentials.ts`'s job) -- a malformed entry here
 *   simply never matches rather than throwing, so a row written before this function existed cannot
 *   make `resolve()` itself misbehave.
 */
export function originMatchesAllowlist(url: URL, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((pattern) => {
    let allowed: URL
    try {
      allowed = new URL(pattern)
    } catch {
      return false
    }
    if (url.protocol !== allowed.protocol || url.host !== allowed.host) {
      return false
    }
    const prefix = allowed.pathname === '/' ? '' : allowed.pathname.replace(/\/+$/, '')
    return prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
  })
}
