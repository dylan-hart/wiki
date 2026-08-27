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
 * Expands an IPv6 literal (`::` zero-compression and an embedded IPv4 dotted-quad tail both
 * handled) into its eight 16-bit groups. Returns `null` if the literal isn't well-formed enough to
 * expand -- `isPrivateIPv6` only ever calls this on a string `net.isIP` already confirmed is type
 * 6, so `null` in practice means "shouldn't happen", not "probably a normal address".
 */
function parseIPv6Groups(address: string): number[] | null {
  const halves = address.split('::')
  if (halves.length > 2) {
    return null // more than one '::' collapse is not a valid literal
  }
  const hasDoubleColon = halves.length === 2
  const splitSide = (side: string): string[] => (side.length === 0 ? [] : side.split(':'))
  const head = splitSide(halves[0])
  const tail = hasDoubleColon ? splitSide(halves[1]) : []

  // An embedded IPv4 dotted-quad (`::ffff:a.b.c.d`, `::a.b.c.d`) only ever appears as the very last
  // group -- reconstitute it into two hex groups before treating everything else as plain hex.
  const lastSide = tail.length > 0 ? tail : head
  const lastGroup = lastSide[lastSide.length - 1]
  if (lastGroup?.includes('.')) {
    const octets = lastGroup.split('.').map(Number)
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null
    }
    lastSide.splice(
      lastSide.length - 1,
      1,
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16)
    )
  }

  const knownCount = head.length + tail.length
  if (hasDoubleColon ? knownCount > 8 : knownCount !== 8) {
    return null
  }
  const groupStrings = [...head, ...Array(8 - knownCount).fill('0'), ...tail]

  const groups: number[] = []
  for (const group of groupStrings) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null
    }
    groups.push(Number.parseInt(group, 16))
  }
  return groups
}

/**
 * Tests real address-range prefixes against the address's canonical binary form (eight 16-bit
 * groups), rather than the string form `net.isIP`/the WHATWG URL parser happen to hand back. The
 * previous implementation matched IPv4-mapped addresses as dotted-quad text and everything else by
 * string-prefixing the first colon-separated group -- but `url.hostname` normalises an IPv4-mapped
 * literal into *hex group* form (`::ffff:a9fe:a9fe`, never `::ffff:169.254.169.254`), which matched
 * neither the dotted-quad regex nor any recognised prefix and so silently returned `false` for a
 * literal that resolves straight to the cloud metadata endpoint (OpenProject #2236).
 */
function isPrivateIPv6(address: string): boolean {
  const groups = parseIPv6Groups(address.toLowerCase())
  if (!groups) {
    return true // fail closed: a literal `net.isIP` accepted but this couldn't expand is not provably public
  }

  if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1)) {
    return true // ::1/128 (loopback) and ::/128 (unspecified)
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true // fe80::/10 -- link-local, by the top 10 bits of the first group
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true // fc00::/7 -- unique local, by the top 7 bits of the first group
  }
  // ::ffff:0:0/96 -- IPv4-mapped; reconstruct the embedded IPv4 from the last two groups and
  // delegate to isPrivateIPv4 rather than special-casing address ranges twice.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [group7, group8] = [groups[6], groups[7]]
    const embedded = [group7 >> 8, group7 & 0xff, group8 >> 8, group8 & 0xff].join('.')
    return isPrivateIPv4(embedded)
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
