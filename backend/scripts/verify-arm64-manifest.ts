/* eslint-disable no-console -- a release-verification script: its stdout IS its result, and it runs outside a booted `CARDINAL`. */
/*
  Verifies that a published Docker image reference is genuinely multi-arch, covering linux/amd64 and
  linux/arm64. `dev/build/arm-host-smoke-test.sh` is the other half, confirming the image actually
  *runs* on real arm64 hardware rather than merely being listed. Run it by hand, from the repo root,
  against the tag a release just published:

    node backend/scripts/verify-arm64-manifest.ts ghcr.io/<owner>/<repo>:<version>

  It shells out to `docker buildx imagetools inspect --raw <image-ref>`, which returns the raw
  OCI/Docker manifest-list JSON with no pull required. Deliberately not a bare HTTP client against the
  registry API: buildx already speaks that protocol correctly (auth, redirects, the two content-type
  variants), and is what the rest of this repo's CI already depends on.

  The correctness trap this exists to avoid: `release.yml` builds with `provenance: mode=max` and
  `sbom: true`, so buildx attaches *attestation* manifests to the same manifest list, each reporting
  `platform.architecture: "unknown"` — its convention for a non-runnable blob, not a real platform. A
  naive substring check like `rawJson.includes('"architecture":"arm64"')` would therefore pass on an
  amd64-only image that merely has attestations attached, so `extractPlatforms` filters strictly to
  `os/architecture` pairs that are not "unknown".
*/
import { execFileSync } from 'node:child_process'

/** 32-bit `linux/arm/v7` is explicitly out of scope. */
export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64']

export interface ManifestListEntryPlatform {
  os?: string
  architecture?: string
}

export interface ManifestListEntry {
  platform?: ManifestListEntryPlatform
}

export interface RawManifestList {
  manifests?: ManifestListEntry[]
}

/**
 * A payload with no `manifests` array at all (a single-platform image, not a manifest list) yields an
 * empty array rather than throwing: "zero listed platforms" is exactly the failure to report.
 */
export function extractPlatforms(raw: RawManifestList): string[] {
  if (!raw || !Array.isArray(raw.manifests)) return []
  const platforms: string[] = []
  for (const entry of raw.manifests) {
    const os = entry?.platform?.os
    const architecture = entry?.platform?.architecture
    if (!os || !architecture || architecture === 'unknown') continue
    platforms.push(`${os}/${architecture}`)
  }
  return platforms
}

export function missingPlatforms(
  present: string[],
  required: string[] = REQUIRED_PLATFORMS
): string[] {
  return required.filter((platform) => !present.includes(platform))
}

export function formatReport(imageRef: string, present: string[], missing: string[]): string {
  if (missing.length === 0) {
    return `PASS: ${imageRef} includes every required platform: ${present.join(', ')}`
  }
  const presentLine = present.length > 0 ? present.join(', ') : '(none)'
  return (
    `FAIL: ${imageRef} is missing required platform(s): ${missing.join(', ')}\n` +
    `  Present: ${presentLine}`
  )
}

function main() {
  const imageRef = process.argv[2]
  if (!imageRef) {
    console.error('Usage: node backend/scripts/verify-arm64-manifest.ts <image-ref>')
    console.error(
      'Example: node backend/scripts/verify-arm64-manifest.ts ghcr.io/<owner>/<repo>:3.1.0'
    )
    process.exit(2)
  }

  let rawOutput: string
  try {
    rawOutput = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', imageRef], {
      encoding: 'utf8'
    })
  } catch (err: any) {
    console.error(`Failed to inspect ${imageRef}: ${err.message}`)
    process.exit(1)
    return
  }

  let raw: RawManifestList
  try {
    raw = JSON.parse(rawOutput)
  } catch (err: any) {
    console.error(`Failed to parse manifest JSON for ${imageRef}: ${err.message}`)
    process.exit(1)
    return
  }

  const present = extractPlatforms(raw)
  const missing = missingPlatforms(present)
  console.log(formatReport(imageRef, present, missing))
  process.exit(missing.length === 0 ? 0 : 1)
}

// Importing this module (as the test does, for the pure functions above) must not shell out to
// docker or call `process.exit`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
