/* eslint-disable no-console -- a release-verification script: its stdout IS its result, and it runs outside a booted `WIKI`. */
/*
  Verifies that a published Docker image reference is genuinely multi-arch, covering
  linux/amd64 and linux/arm64 — the manifest-side half of OpenProject #2488 ("Verify published
  multi-arch manifest on a real ARM host"), part of Epic #2435's scope. See
  docs/release-checklist.md for where this fits in the release runbook; `dev/build/arm-host-smoke-test.sh`
  is the other half (confirming the image actually *runs* on real arm64 hardware, not just that the
  manifest lists it).

  Run it by hand, from the repo root, against the tag a release just published:

    node backend/scripts/verify-arm64-manifest.ts ghcr.io/<owner>/<repo>:<version>

  It shells out to `docker buildx imagetools inspect --raw <image-ref>`, which returns the raw
  OCI/Docker manifest-list JSON for a multi-platform image with no pull required. This intentionally
  does NOT reimplement manifest parsing with a bare HTTP client against the registry API — buildx
  already speaks that protocol correctly (auth, redirects, the two content-type variants), and
  `imagetools inspect` is the tool the rest of this repo's CI already depends on
  (`docker/setup-buildx-action` in build.yml/release.yml).

  One correctness trap this script exists to avoid: `release.yml` builds with
  `provenance: mode=max` and `sbom: true` (see that workflow's "Build and push Docker images" step),
  which makes buildx attach one or more *attestation* manifests to the same manifest list — each
  reporting `platform.architecture: "unknown"` (buildx's own convention for a non-runnable
  attestation blob, not a real platform). A naive substring check like
  `rawJson.includes('"architecture":"arm64"')` would pass on a single-arch amd64-only image that
  merely has attestations attached, since those don't establish arm64 as a real, runnable platform.
  `extractPlatforms` below filters strictly to `os/architecture` pairs that are not "unknown".
*/
import { execFileSync } from 'node:child_process'

/** The two platforms Epic #2435's scope requires — 32-bit linux/arm/v7 is explicitly out of scope. */
export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64']

/** The one field of a manifest-list entry this script actually reads. */
export interface ManifestListEntryPlatform {
  os?: string
  architecture?: string
}

export interface ManifestListEntry {
  platform?: ManifestListEntryPlatform
}

/** The subset of `docker buildx imagetools inspect --raw`'s output shape this script reads. */
export interface RawManifestList {
  manifests?: ManifestListEntry[]
}

/**
 * `os/architecture` strings for every REAL platform in a manifest-list payload — attestation/SBOM
 * sub-manifests (buildx marks these `architecture: "unknown"`) are excluded, and a payload with no
 * `manifests` array at all (a single-platform image, not a manifest list) yields an empty array
 * rather than throwing, since "this image has zero listed platforms" is exactly the failure this
 * script exists to report.
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

/** Which of `required` are absent from `present` — empty means every required platform is covered. */
export function missingPlatforms(
  present: string[],
  required: string[] = REQUIRED_PLATFORMS
): string[] {
  return required.filter((platform) => !present.includes(platform))
}

/** Human-readable pass/fail summary for a given image ref, ready to print. */
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

// Only run when executed directly — importing this module (as the test file does, for the pure
// functions above) must not shell out to docker or call process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
