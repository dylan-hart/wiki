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
 * Whether `value` is syntactically a valid `allowedOrigins` entry for a block credential: an
 * absolute `http:`/`https:` URL naming a scheme, host, optional port, and path prefix, with no query
 * string or userinfo, and no fragment (OpenProject #2195, narrowing the hostname-only allowlist this
 * replaced). Either a query string or a fragment would leave "does this request URL fall under the
 * allowed prefix" ambiguous — a query string carries no path information at all, and a fragment is
 * never even sent to the server — so both are refused here rather than silently ignored at match
 * time. Userinfo (`user:pass@host`) is refused for the same reason `URL`'s own username/password
 * fields are never read anywhere else in this codebase: it is no part of "which origin", and a
 * pattern that includes it would misleadingly suggest the allowlist itself carries credentials.
 *
 * Used by both the block-credential route schema and (mirrored, since `frontend/` cannot import from
 * `backend/` — see root `CLAUDE.md`'s workspace layout) `frontend/src/helpers/originPattern.js`'s copy
 * for `BlockCredentialDialog.vue`'s inline validation.
 */
export function isValidOriginPrefixPattern(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/**
 * Whether `path` falls under the path prefix `pattern.pathname` names, respecting path-segment
 * boundaries: a prefix of `/v1` matches `/v1` and `/v1/data` but not `/v1extra` — a naive
 * `startsWith` would let a stored prefix also cover an entirely different endpoint that merely
 * happens to share those characters, which is exactly the kind of silent over-authorization a
 * path-prefix allowlist exists to rule out.
 */
function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (prefix === '' || prefix === '/') {
    return true
  }
  const trimmedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return path === trimmedPrefix || path.startsWith(`${trimmedPrefix}/`)
}

/**
 * Whether `url` is covered by any pattern in `allowedOrigins` — the enforcement half of the
 * per-credential allowlist (OpenProject #868, narrowed from a hostname-only match to an origin plus
 * path prefix by #2195). An empty list matches nothing: `models/blockCredentials.ts` requires at
 * least one entry at creation time specifically so this function is never the only thing standing
 * between "credential exists" and "credential unusable."
 *
 * Every one of scheme, host, port and path prefix must agree — unlike the hostname-only match this
 * replaced, an allowlist entry no longer silently authorizes every path (or a different port, or a
 * plaintext request) an admin never actually intended when they named just a domain. Matching is
 * exact on `origin` (`URL.prototype.origin` already normalizes host casing), and prefix-based, with
 * segment boundaries, on the path — see {@link pathMatchesPrefix}.
 */
export function urlMatchesAllowlist(url: URL, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((pattern) => {
    let entry: URL
    try {
      entry = new URL(pattern)
    } catch {
      return false
    }
    return url.origin === entry.origin && pathMatchesPrefix(url.pathname, entry.pathname)
  })
}
