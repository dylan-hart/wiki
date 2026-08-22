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
