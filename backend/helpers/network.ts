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
 * Whether `hostname` is covered by any pattern in `allowedDomains` — the enforcement half of the
 * per-credential domain allowlist (OpenProject #868 follow-up). An empty list matches nothing:
 * `models/blockCredentials.ts` requires at least one domain at creation time specifically so this
 * function is never the only thing standing between "credential exists" and "credential unusable."
 *
 * Matching is case-insensitive. A pattern starting with `*.` matches exactly one extra label before
 * the given suffix — the same convention a TLS wildcard certificate uses (`*.example.com` matches
 * `api.example.com`, not `example.com` itself and not `a.b.example.com`) — chosen because it is the
 * behavior most people already carry an intuition for, and it does not silently cover a whole
 * multi-level subtree an admin may not have intended. Any other pattern (including a bare IP
 * literal, since a URL's `hostname` for an IP-literal address is the literal itself) matches only by
 * exact string equality.
 */
export function hostnameMatchesAllowlist(hostname: string, allowedDomains: string[]): boolean {
  const target = hostname.toLowerCase()
  return allowedDomains.some((pattern) => {
    const normalized = pattern.toLowerCase()
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(1) // ".example.com"
      if (!target.endsWith(suffix)) {
        return false
      }
      const prefix = target.slice(0, target.length - suffix.length)
      return prefix.length > 0 && !prefix.includes('.')
    }
    return target === normalized
  })
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
 * credential's secret get sent here" is `hostnameMatchesAllowlist`'s exact-string match at resolve
 * time; this only guards against an admin fat-fingering the syntax `hostnameMatchesAllowlist`
 * accepts, so a slightly permissive match costs nothing a strict one would have caught anyway.
 *
 * The brackets are required, not optional: `URL.prototype.hostname` for an IPv6-literal authority
 * always carries them (`new URL('http://[::1]/').hostname === '[::1]'`), and `hostnameMatchesAllowlist`
 * compares an entry against that hostname by exact string -- an unbracketed entry would validate here
 * but could then never actually match at resolve time, silently making every IPv6 allowlist entry
 * unusable (OpenProject #1099 follow-up).
 */
const DOMAIN_IPV6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'

/**
 * The regex source for one `allowedDomains` entry -- either (optionally `*.`-prefixed) a hostname, or
 * a bare IPv6 literal. An IPv4 literal is already covered by the hostname branch: each octet is just
 * digits, which is a valid `DOMAIN_LABEL` on its own (OpenProject #1099).
 *
 * Kept as a string (not just the compiled `DOMAIN_PATTERN` below) specifically so
 * `api/blockCredentials.ts` can splice it straight into the JSON Schema `pattern` for
 * `allowedDomains` items -- the backend route and this helper's own `isValidDomainPattern` share one
 * definition of "valid" rather than risking two that quietly drift apart.
 */
export const DOMAIN_PATTERN_SOURCE = `^(?:\\*\\.)?${DOMAIN_HOSTNAME}$|^${DOMAIN_IPV6}$`

const DOMAIN_PATTERN = new RegExp(DOMAIN_PATTERN_SOURCE)

/**
 * Whether `value` is syntactically a valid `allowedDomains` entry -- the same shape
 * `hostnameMatchesAllowlist` actually matches against: an exact hostname, a `*.`-prefixed wildcard,
 * an IPv4 literal (matches as a hostname), or a `[`/`]`-bracketed IPv6 literal. Used by both the block-credential route
 * schema and (mirrored, since `frontend/` cannot import from `backend/` -- see root `CLAUDE.md`'s
 * workspace layout) `frontend/src/helpers/domainPattern.js`'s copy for `BlockCredentialDialog.vue`'s
 * inline validation (OpenProject #1099).
 */
export function isValidDomainPattern(value: string): boolean {
  return DOMAIN_PATTERN.test(value)
}
