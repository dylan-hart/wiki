# Decision: use an IP+User-Agent hash as the "new device/location" signal, not a geoIP lookup

**Date:** 2026-09-15 · **Context:** OpenProject #3302 (Send email on new-device/new-location TFA
login), under Feature #3289

## Background

#3302's scope is to design and build device/location tracking from scratch — a grep for
`newDevice`/`newLocation`/`loginHistory`/`knownDevice` under `backend/` turned up nothing, and this
codebase has no geoIP/MaxMind/ipinfo dependency or lookup of any kind (confirmed by grep across
`backend/`).

## Decision

Track one signal, not two: a `tfaKnownDevices` row per (user, fingerprint), where `fingerprint` is
`generateHash(\`${ip}|${userAgent}\`)`(see`helpers/common.ts#generateHash`, the same sha1 helper
already used for cache/asset hashing elsewhere). "Device" and "location" collapse into this one
fingerprint rather than being tracked as two independent fields:

- A genuinely new browser/OS (new User-Agent) is a new fingerprint even from the same IP.
- A genuinely new network (new IP) is a new fingerprint even from the same browser/OS.
- Without a geoIP database there is no way to tell "same city, different IP" (e.g. a home ISP
  reassigning a dynamic address) from "different continent" — both are just "different IP" to this
  codebase. Splitting the columns would imply a distinction the data cannot actually support.

`ip` and `userAgent` are stored in the clear alongside the hash (not just the hash) purely so a
future admin-facing "known devices" list has something human-readable to show. Nothing reads them
back yet — no such UI exists as of this WP.

## Consequences

- No new runtime dependency (a MaxMind/ipinfo-style geoIP package) was added for this task.
- A user behind a carrier-grade NAT or a VPN that rotates exit IPs will see more "new device" emails
  than a geoIP-based "new city" heuristic would produce. This is treated as an acceptable false-positive
  rate for a security notice — the cost of a false "new login" email is low, and erring toward the
  account owner's ISP change is safer than erring toward a geoIP database's blind spots.
- If a real geoIP capability is added to this codebase later for other reasons, this table's
  `fingerprint` is the one thing that would need revisiting to fold location in properly; `ip`/
  `userAgent` are already there to build against.
