import net from 'node:net'

/**
 * SSRF guard for a server-side fetch driven by author-supplied input: without it, anyone holding
 * `write:pages` could have the wiki server fetch a cloud metadata endpoint (`169.254.169.254`), a
 * loopback admin panel, or any other address a plain internet client could never have reached.
 *
 * @param address A literal IP address, brackets already stripped for IPv6. A hostname returns
 *   `false` here — callers resolve DNS first and check every address it comes back with.
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
 * One 16-bit hex group per segment -- two when the segment is a dotted-quad IPv4 literal
 * (`::ffff:169.254.169.254`, which `net.isIP` accepts alongside the hex-group spelling
 * `URL.hostname` normalises to).
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
 * groups. Does not validate: every caller has already passed `net.isIP(address) === 6`, for which
 * padding a `::` collapse out to 8 groups is well-defined.
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
 * Tests the expanded groups rather than string prefixes, which cannot see through `::` collapse: the
 * WHATWG URL parser (what produces `url.hostname`) normalises an IPv4-mapped literal into hex groups
 * and collapses runs of zeros, so `::ffff:169.254.169.254` becomes `::ffff:a9fe:a9fe` -- a shape no
 * dotted-quad regex or first-group prefix check can match.
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
  // fe80::/10 -- link-local
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true
  }
  // fc00::/7 -- unique local
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true
  }
  // ::ffff:0:0/96 -- IPv4-mapped: the last two groups embed the IPv4 address
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
  // ::a.b.c.d/96 -- legacy IPv4-compatible embedding (RFC 4291): deprecated, but still accepted by
  // net.isIP and normalised into hex groups by the URL parser the same way the mapped form is.
  // `::` and `::1` are already handled above.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const embeddedIPv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(
      '.'
    )
    return isPrivateIPv4(embeddedIPv4)
  }
  return false
}

/**
 * A DNS label. Both cases are spelled out rather than relying on a regex `i` flag so this source can
 * be embedded as a JSON Schema `pattern`, which Ajv applies with no flags.
 */
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const DOMAIN_HOSTNAME = `${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*`
/**
 * Deliberately loose rather than RFC 4291-compliant: enforcement is `originMatchesAllowlist`'s
 * comparison at resolve time, and this only guards against an admin fat-fingering the syntax.
 *
 * The brackets are required: `URL.prototype.hostname` for an IPv6-literal authority always carries
 * them (`new URL('http://[::1]/').hostname === '[::1]'`), and `originMatchesAllowlist` compares by
 * exact string -- an unbracketed entry would validate here but never match at resolve time.
 */
const DOMAIN_IPV6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'

/** Both cases spelled out for the same reason as {@link DOMAIN_LABEL}. */
const SCHEME_PATTERN = '[hH][tT][tT][pP][sS]?'

/**
 * One `allowedOrigins` entry: a full origin -- scheme, host (optionally `*.`-prefixed, or a
 * bracketed IPv6 literal), and an optional `:port` -- plus an optional path prefix, with no query or
 * fragment.
 *
 * Exported as a string so the route's JSON Schema `pattern` for `allowedOrigins` items and
 * `isValidOriginPattern` share one definition of "valid".
 */
export const ORIGIN_PATTERN_SOURCE = `^${SCHEME_PATTERN}:\\/\\/(?:${DOMAIN_IPV6}|(?:\\*\\.)?${DOMAIN_HOSTNAME})(?::[0-9]{1,5})?(?:\\/[^?#]*)?$`

const ORIGIN_PATTERN = new RegExp(ORIGIN_PATTERN_SOURCE)

/**
 * Mirrored in `frontend/src/helpers/originPattern.js`, since `frontend/` cannot import from
 * `backend/` -- keep in sync.
 *
 * Deliberately narrower than what `new URL()` itself would accept: no userinfo (`user:pass@host`),
 * which `URL`'s own parser would silently accept and discard.
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

/** Capturing counterpart of {@link ORIGIN_PATTERN_SOURCE} -- keep in sync. */
const ORIGIN_PARSE = new RegExp(
  `^(${SCHEME_PATTERN}):\\/\\/(${DOMAIN_IPV6}|(?:\\*\\.)?${DOMAIN_HOSTNAME})(?::([0-9]{1,5}))?(\\/[^?#]*)?$`
)

interface ParsedAllowedOrigin {
  scheme: string
  /** Still `*.`-prefixed or `[`/`]`-bracketed if the entry was. */
  hostPattern: string
  port: string | null
  pathPrefix: string
}

/**
 * The `null` is defensive only: every entry reaching this from storage was validated by
 * {@link isValidOriginPattern} first.
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

/** A `*.` wildcard covers exactly one extra label: `a.example.com`, not `a.b.example.com`. */
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

/** Matches on a `/`-boundary: `/v1` covers `/v1` and `/v1/x`, not `/v1x`. */
function pathWithinPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') {
    return true
  }
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

/**
 * Each entry names a full origin plus an optional path prefix — e.g. `https://api.example.com/v1` —
 * not a bare hostname: a credential's secret is bound to the one endpoint family an admin configured
 * it for, not to every scheme, port and path the allowed host happens to answer on. An omitted port
 * defaults per scheme, so `https://host` and `https://host:443` are the same entry.
 *
 * `models/liveData.ts#resolve()` separately refuses any credentialed request that is not `https:`,
 * so scheme needs no special case beyond the equality check here.
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
