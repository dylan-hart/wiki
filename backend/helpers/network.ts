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
 * credential's secret get sent here" is `originMatchesAllowlist`'s host/port/path comparison at
 * resolve time; this only guards against an admin fat-fingering the syntax `originMatchesAllowlist`
 * accepts, so a slightly permissive match costs nothing a strict one would have caught anyway.
 *
 * The brackets are required, not optional: `URL.prototype.hostname` for an IPv6-literal authority
 * always carries them (`new URL('http://[::1]/').hostname === '[::1]'`), and `originMatchesAllowlist`
 * compares an entry's host against that hostname by exact string -- an unbracketed entry would
 * validate here but could then never actually match at resolve time, silently making every IPv6
 * allowlist entry unusable (OpenProject #1099 follow-up, still true of the origin+prefix shape).
 */
const DOMAIN_IPV6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'

/**
 * `http`/`https`, both cases spelled out explicitly rather than a regex `i` flag -- see
 * {@link DOMAIN_LABEL}'s comment for why: this same source is embedded directly into a JSON Schema
 * `pattern`, which Ajv applies with no flags.
 */
const SCHEME_PATTERN = '[hH][tT][tT][pP][sS]?'

/**
 * The regex source for one `allowedDomains` entry (OpenProject #2185, replacing the hostname-only
 * shape this superseded): a full origin -- scheme, host (optionally `*.`-prefixed, or a bracketed
 * IPv6 literal), and an optional `:port` -- plus an optional path prefix, with no query or fragment
 * (`[^?#]*` after the leading `/`, anchored to the end of the string, is what rules those out).
 *
 * Kept as a string (not just the compiled {@link ORIGIN_PATTERN} below) specifically so
 * `api/blockCredentials.ts` can splice it straight into the JSON Schema `pattern` for
 * `allowedDomains` items -- the backend route and this helper's own `isValidOriginPattern` share one
 * definition of "valid" rather than risking two that quietly drift apart.
 */
export const ORIGIN_PATTERN_SOURCE = `^${SCHEME_PATTERN}:\\/\\/(?:${DOMAIN_IPV6}|(?:\\*\\.)?${DOMAIN_HOSTNAME})(?::[0-9]{1,5})?(?:\\/[^?#]*)?$`

const ORIGIN_PATTERN = new RegExp(ORIGIN_PATTERN_SOURCE)

/**
 * Whether `value` is syntactically a valid `allowedDomains` entry -- the same origin+prefix shape
 * {@link originMatchesAllowlist} actually matches against. Used by both the block-credential route
 * schema and (mirrored, since `frontend/` cannot import from `backend/` -- see root `CLAUDE.md`'s
 * workspace layout) `frontend/src/helpers/originPattern.js`'s copy for `BlockCredentialDialog.vue`'s
 * inline validation.
 */
export function isValidOriginPattern(value: string): boolean {
  return ORIGIN_PATTERN.test(value)
}

/** Capturing counterpart of {@link ORIGIN_PATTERN_SOURCE}, for {@link parseAllowedOrigin}. */
const ORIGIN_PARSE = new RegExp(
  `^(${SCHEME_PATTERN}):\\/\\/(${DOMAIN_IPV6}|(?:\\*\\.)?${DOMAIN_HOSTNAME})(?::([0-9]{1,5}))?(\\/[^?#]*)?$`
)

interface ParsedAllowedOrigin {
  /** Lowercased -- `SCHEME_PATTERN` accepts either case, but comparison is always case-insensitive. */
  scheme: string
  /** Lowercased host, still `*.`-prefixed or `[`/`]`-bracketed if the entry was. */
  hostPattern: string
  /** `null` when the entry named no port -- the caller defaults it per scheme. */
  port: string | null
  /** Always at least `/`, the entry's own leading slash included when it named one. */
  pathPrefix: string
}

/**
 * Splits one already-validated `allowedDomains` entry into its parts, or `null` for a string that
 * does not match {@link ORIGIN_PATTERN} at all (defensive only -- every entry reaching this from
 * storage was validated by {@link isValidOriginPattern} first).
 */
function parseAllowedOrigin(pattern: string): ParsedAllowedOrigin | null {
  const match = ORIGIN_PARSE.exec(pattern)
  if (!match) {
    return null
  }
  return {
    scheme: match[1]!.toLowerCase(),
    hostPattern: match[2]!.toLowerCase(),
    port: match[3] ?? null,
    pathPrefix: match[4] ?? '/'
  }
}

function defaultPortFor(scheme: string): string {
  return scheme === 'https' ? '443' : '80'
}

/** Same `*.`-wildcard convention `hostnameMatchesAllowlist` used to document: one extra label only. */
function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const target = hostname.toLowerCase()
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    if (!target.endsWith(suffix)) {
      return false
    }
    const prefix = target.slice(0, target.length - suffix.length)
    return prefix.length > 0 && !prefix.includes('.')
  }
  return target === pattern
}

/** Whether `pathname` falls within `prefix` on a `/`-boundary: `/v1` matches `/v1` and `/v1/x`, not `/v1x`. */
function pathWithinPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') {
    return true
  }
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

/**
 * Whether `url` is covered by any entry in `allowedOrigins` — the enforcement half of the
 * per-credential origin+path-prefix allowlist (OpenProject #2185, replacing the hostname-only
 * `hostnameMatchesAllowlist` this superseded — that function compared a request's hostname alone,
 * leaving scheme, port, path and query entirely up to the caller). An empty list matches nothing:
 * `models/blockCredentials.ts` requires at least one entry at creation time specifically so this
 * function is never the only thing standing between "credential exists" and "credential unusable."
 *
 * Each entry names a full origin (scheme + host[:port]) plus an optional path prefix — e.g.
 * `https://api.example.com/v1` — not a bare hostname: a credential's secret is bound to the one
 * endpoint family an admin configured it for, not to every path (and every scheme, and every port)
 * the allowed host happens to answer on. A port an entry omits defaults per scheme (80 for `http:`,
 * 443 for `https:`), the same default a browser's own same-origin check uses, so `https://host` and
 * `https://host:443` are the same entry.
 */
export function originMatchesAllowlist(url: URL, allowedOrigins: string[]): boolean {
  const targetScheme = url.protocol.slice(0, -1).toLowerCase() // "https:" -> "https"
  return allowedOrigins.some((pattern) => {
    const parsed = parseAllowedOrigin(pattern)
    if (!parsed) {
      return false
    }
    if (targetScheme !== parsed.scheme) {
      return false
    }
    if (!hostMatchesPattern(url.hostname, parsed.hostPattern)) {
      return false
    }
    const targetPort = url.port || defaultPortFor(targetScheme)
    const patternPort = parsed.port || defaultPortFor(parsed.scheme)
    if (targetPort !== patternPort) {
      return false
    }
    return pathWithinPrefix(url.pathname, parsed.pathPrefix)
  })
}
