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

/**
 * Splits one colon-delimited segment into its 16-bit hex groups -- one, unless the segment is itself a
 * dotted-quad IPv4 literal (the legacy IPv4-compatible/-mapped spelling, `::ffff:169.254.169.254`, which
 * `net.isIP` accepts alongside the hex-group spelling `URL.hostname` actually normalises to), in which
 * case it is two: `net.isIP`'s own accepted grammar puts a dotted quad only in the trailing segment, so
 * expanding whichever segment has a `.` in it -- not just the last -- covers both spellings with one
 * rule.
 */
function expandSegment(segment: string): string[] {
  if (!segment.includes('.')) {
    return [segment]
  }
  const octets = segment.split('.').map(Number)
  return [
    (((octets[0] << 8) | octets[1]) & 0xffff).toString(16),
    (((octets[2] << 8) | octets[3]) & 0xffff).toString(16)
  ]
}

/**
 * Expands an IPv6 literal (`::` collapse included, dotted-quad tail included) into its eight 16-bit
 * groups, so a caller can test real bit-prefixes instead of string prefixes.
 *
 * `net.isIP(address) === 6` is assumed already true of every caller (see {@link isPrivateAddress}), so
 * this does not re-validate the address -- a `::` collapse is expanded by padding with as many `0`
 * groups as are missing from the expected 8, which is well-defined for any address that passed
 * `net.isIP`.
 */
function parseIPv6Groups(address: string): number[] {
  const normalized = address.toLowerCase()
  const [head, tail] = normalized.includes('::') ? normalized.split('::') : [normalized, undefined]
  const headGroups = head.length > 0 ? head.split(':').flatMap(expandSegment) : []
  const tailGroups =
    tail !== undefined && tail.length > 0 ? tail.split(':').flatMap(expandSegment) : []
  const missing = 8 - headGroups.length - tailGroups.length
  const allGroups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups]
  return allGroups.map((group) => Number.parseInt(group || '0', 16))
}

/**
 * Whether an IPv6 literal falls in a private, loopback, link-local, or IPv4-mapped-private range,
 * tested against a canonical binary form (the address's eight 16-bit groups) rather than string
 * prefixes.
 *
 * String-prefix matching against `address.split(':')[0]` cannot see through `::` collapse: the WHATWG
 * URL parser (what actually produces `url.hostname`) always normalises an IPv4-mapped IPv6 literal into
 * hex-group form and collapses runs of zero groups, so `::ffff:169.254.169.254` becomes
 * `::ffff:a9fe:a9fe` -- a shape no dotted-quad regex or `firstGroup.startsWith(...)` check can match,
 * and one for which `address.split(':')[0]` is simply the empty string. Expanding to real groups first
 * makes every one of these forms compare identically to their non-collapsed equivalent.
 */
function isPrivateIPv6(address: string): boolean {
  const groups = parseIPv6Groups(address)
  if (groups.every((group) => group === 0)) {
    return true // :: -- unspecified
  }
  const isLoopback =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  if (isLoopback) {
    return true // ::1/128 -- loopback
  }
  // fe80::/10 -- link-local: top 10 bits of the first group are 1111111010
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true
  }
  // fc00::/7 -- unique local: top 7 bits of the first group are 1111110
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true
  }
  // ::ffff:0:0/96 -- IPv4-mapped: the top 96 bits (groups 1-6) are 0:0:0:0:0:ffff, and the last two
  // groups (7 and 8, i.e. indices 6 and 7) embed the IPv4 address, two octets per 16-bit group.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const embeddedIPv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(
      '.'
    )
    return isPrivateIPv4(embeddedIPv4)
  }
  return false
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
 * The regex source for one `allowedOrigins` entry (OpenProject #2185/#2195, replacing the
 * hostname-only shape this superseded): a full origin -- scheme, host (optionally `*.`-prefixed, or
 * a bracketed IPv6 literal), and an optional `:port` -- plus an optional path prefix, with no query
 * or fragment (`[^?#]*` after the leading `/`, anchored to the end of the string, is what rules
 * those out).
 *
 * Kept as a string (not just the compiled {@link ORIGIN_PATTERN} below) specifically so
 * `api/blockCredentials.ts` can splice it straight into the JSON Schema `pattern` for
 * `allowedOrigins` items -- the backend route and this helper's own `isValidOriginPattern` share one
 * definition of "valid" rather than risking two that quietly drift apart.
 */
export const ORIGIN_PATTERN_SOURCE = `^${SCHEME_PATTERN}:\\/\\/(?:${DOMAIN_IPV6}|(?:\\*\\.)?${DOMAIN_HOSTNAME})(?::[0-9]{1,5})?(?:\\/[^?#]*)?$`

const ORIGIN_PATTERN = new RegExp(ORIGIN_PATTERN_SOURCE)

/**
 * Whether `value` is syntactically a valid `allowedOrigins` entry -- the same origin+prefix shape
 * {@link originMatchesAllowlist} actually matches against. Used by both the block-credential route
 * schema and (mirrored, since `frontend/` cannot import from `backend/` -- see root `CLAUDE.md`'s
 * workspace layout) `frontend/src/helpers/originPattern.js`'s copy for `BlockCredentialDialog.vue`'s
 * inline validation.
 *
 * Deliberately narrower than what `new URL()` itself would accept: no userinfo (`user:pass@host`),
 * since that has no business in a stored allowlist entry and `URL`'s own parser would silently
 * accept and discard it (OpenProject #2198).
 */
export function isValidOriginPattern(value: string): boolean {
  if (!ORIGIN_PATTERN.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return !url.username && !url.password
  } catch {
    return false
  }
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
 * Splits one already-validated `allowedOrigins` entry into its parts, or `null` for a string that
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
 * per-credential origin+path-prefix allowlist (OpenProject #2185/#2195, replacing the hostname-only
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
 *
 * `models/liveData.ts#resolve()` separately refuses any credentialed request whose own scheme is not
 * `https:` (OpenProject #2198) -- this function does not special-case scheme beyond the plain
 * equality check above, since a stored `http:` entry can never match a request forced to `https:`
 * anyway.
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
