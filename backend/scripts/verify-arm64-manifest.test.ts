/**
 * Pure unit tests for `verify-arm64-manifest.ts`'s manifest-parsing logic (OpenProject #2488).
 * No Docker daemon, network, or real registry access needed — every case here drives the exported
 * functions directly against fixture JSON shaped like real `docker buildx imagetools inspect --raw`
 * output, the same way `backend/scripts/audit-site-scoped-rules.test.ts` drives its script's pure
 * functions without a database.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_PLATFORMS,
  extractPlatforms,
  missingPlatforms,
  formatReport,
  type RawManifestList
} from './verify-arm64-manifest.ts'

/** A real multi-arch manifest list also carries buildx attestation sub-manifests when the image was
 * built with `provenance`/`sbom` enabled (release.yml enables both) — each reports
 * `architecture: "unknown"` and must not be mistaken for a real platform. */
const MULTI_ARCH_WITH_ATTESTATIONS: RawManifestList = {
  manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    { platform: { os: 'linux', architecture: 'arm64' } },
    { platform: { os: 'unknown', architecture: 'unknown' } }, // provenance attestation
    { platform: { os: 'unknown', architecture: 'unknown' } } // SBOM attestation
  ]
}

const AMD64_ONLY: RawManifestList = {
  manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }]
}

const AMD64_ONLY_WITH_ATTESTATION: RawManifestList = {
  manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    { platform: { os: 'unknown', architecture: 'unknown' } }
  ]
}

describe('extractPlatforms', () => {
  test('lists real platforms as "os/architecture" strings', () => {
    assert.deepEqual(extractPlatforms(MULTI_ARCH_WITH_ATTESTATIONS), ['linux/amd64', 'linux/arm64'])
  })

  test('excludes attestation/SBOM sub-manifests (architecture: "unknown")', () => {
    const platforms = extractPlatforms(AMD64_ONLY_WITH_ATTESTATION)
    assert.deepEqual(platforms, ['linux/amd64'])
    assert.ok(!platforms.includes('unknown/unknown'))
  })

  test('single-platform image (no manifests array) yields an empty list, not a throw', () => {
    assert.deepEqual(extractPlatforms({}), [])
    assert.deepEqual(extractPlatforms({ manifests: undefined }), [])
  })

  test('an entry missing os or architecture is skipped rather than producing "undefined/undefined"', () => {
    const platforms = extractPlatforms({
      manifests: [{ platform: { os: 'linux' } }, { platform: {} }, { platform: undefined }]
    })
    assert.deepEqual(platforms, [])
  })
})

describe('missingPlatforms', () => {
  test('empty when every required platform is present', () => {
    assert.deepEqual(missingPlatforms(['linux/amd64', 'linux/arm64']), [])
  })

  test('reports linux/arm64 missing for an amd64-only image', () => {
    assert.deepEqual(missingPlatforms(extractPlatforms(AMD64_ONLY)), ['linux/arm64'])
  })

  test('reports both missing for a completely empty platform list', () => {
    assert.deepEqual(missingPlatforms([]), REQUIRED_PLATFORMS)
  })

  test('extra present platforms beyond the required set do not count as missing', () => {
    assert.deepEqual(missingPlatforms(['linux/amd64', 'linux/arm64', 'linux/arm/v7']), [])
  })

  test('a caller-supplied required list is honored instead of the default', () => {
    assert.deepEqual(missingPlatforms(['linux/amd64'], ['linux/amd64']), [])
  })
})

describe('formatReport', () => {
  test('PASS report names every present platform', () => {
    const report = formatReport('ghcr.io/example/wiki:3.1.0', ['linux/amd64', 'linux/arm64'], [])
    assert.match(report, /^PASS:/)
    assert.match(report, /linux\/amd64/)
    assert.match(report, /linux\/arm64/)
  })

  test('FAIL report names the missing platform(s) and what was actually present', () => {
    const report = formatReport('ghcr.io/example/wiki:3.1.0', ['linux/amd64'], ['linux/arm64'])
    assert.match(report, /^FAIL:/)
    assert.match(report, /linux\/arm64/)
    assert.match(report, /Present: linux\/amd64/)
  })

  test('FAIL report handles zero present platforms without crashing', () => {
    const report = formatReport('ghcr.io/example/wiki:3.1.0', [], REQUIRED_PLATFORMS)
    assert.match(report, /Present: \(none\)/)
  })
})

describe('end-to-end against the full fixture', () => {
  test('a real multi-arch + attestations manifest list passes', () => {
    const present = extractPlatforms(MULTI_ARCH_WITH_ATTESTATIONS)
    assert.deepEqual(missingPlatforms(present), [])
  })

  test('an amd64-only manifest list (the pre-Epic-#2435 status quo) fails on linux/arm64', () => {
    const present = extractPlatforms(AMD64_ONLY_WITH_ATTESTATION)
    assert.deepEqual(missingPlatforms(present), ['linux/arm64'])
  })
})
