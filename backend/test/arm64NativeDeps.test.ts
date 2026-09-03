/**
 * Regression guard for OpenProject #2485 ("Verify native dependencies build correctly under QEMU
 * arm64 emulation"), part of Epic #2435 (adding `linux/arm64` to the Docker build/release
 * pipeline). See `docs/arm64-native-deps-audit.md` for the full write-up this codifies.
 *
 * `backend/`'s dependency tree has exactly five packages with an npm `install` lifecycle script
 * (`hasInstallScript` in `package-lock.json`) — the ones capable of running arbitrary native-addon
 * compilation (node-gyp) at install time. This test pins that set so a future dependency bump that
 * silently introduces a sixth one — or turns one of the existing five from optional/dev into a
 * required production dependency — fails loudly and has to be re-audited for arm64 rather than
 * riding along unnoticed into `dev/build/Dockerfile`'s `npm ci --omit=dev` step.
 *
 * It also pins the two structural facts the audit's "no arm64 blocker" conclusion actually rests
 * on: `sharp` ships a genuine prebuilt (non-source) binary for `linux-arm64`, and `cpu-features`
 * (the one package here that really does need a C++ toolchain — `ssh2`'s optional native
 * accelerator) stays marked `optional` all the way up, so a compile failure for it — on any
 * architecture, arm64 included — degrades `ssh2` to its pure-JS fallback instead of failing the
 * whole `npm ci`.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const PACKAGE_LOCK = path.join(REPO_ROOT, 'backend/package-lock.json')

const lock = JSON.parse(fs.readFileSync(PACKAGE_LOCK, 'utf8'))
const packages: Record<string, any> = lock.packages ?? {}

function shortName(key: string): string {
  return key.split('node_modules/').pop() ?? key
}

describe('backend native/install-script dependency set (OpenProject #2485)', () => {
  test('exactly the five known packages carry an install lifecycle script', () => {
    const withInstallScript = Object.keys(packages)
      .filter((key) => packages[key]?.hasInstallScript)
      .map(shortName)
      .sort()

    assert.deepStrictEqual(
      withInstallScript,
      ['cpu-features', 'esbuild', 'fsevents', 'puppeteer', 'ssh2'],
      'a new hasInstallScript package appeared in package-lock.json — audit it for arm64 ' +
        '(does it ship a prebuilt linux-arm64 binary, or does it need a real compile?) and update ' +
        'docs/arm64-native-deps-audit.md and this allowlist together'
    )
  })

  test('esbuild (the one build-tool install script) is dev-only, so `npm ci --omit=dev` never runs it', () => {
    const entry = packages['node_modules/esbuild']
    assert.ok(entry, 'expected node_modules/esbuild in the lockfile')
    assert.equal(entry.dev, true)
  })

  test('fsevents (macOS-only) is optional and os-restricted away from linux entirely', () => {
    const entry = packages['node_modules/fsevents']
    assert.ok(entry, 'expected node_modules/fsevents in the lockfile')
    assert.equal(entry.optional, true)
    assert.deepStrictEqual(entry.os, ['darwin'])
  })

  test('puppeteer is an optionalDependency, so its install script cannot fail the prod install', () => {
    const entry = packages['node_modules/puppeteer']
    assert.ok(entry, 'expected node_modules/puppeteer in the lockfile')
    assert.equal(entry.optional, true)
  })

  test('cpu-features is optional (ssh2 works without it — no arm64-specific risk from this native compile)', () => {
    const entry = packages['node_modules/cpu-features']
    assert.ok(entry, 'expected node_modules/cpu-features in the lockfile')
    assert.equal(entry.optional, true)
  })

  test('ssh2 declares cpu-features as one of its own optionalDependencies', () => {
    const entry = packages['node_modules/ssh2']
    assert.ok(entry, 'expected node_modules/ssh2 in the lockfile')
    assert.ok(
      entry.optionalDependencies?.['cpu-features'],
      'expected ssh2 to list cpu-features under optionalDependencies — that is what makes a ' +
        'failed native compile for it non-fatal to the whole `npm ci`'
    )
  })
})

describe('sharp ships a real prebuilt linux-arm64 binary, not a source-only package (OpenProject #2485)', () => {
  test('@img/sharp-linux-arm64 is present, optional, and hash-checked', () => {
    const entry = packages['node_modules/@img/sharp-linux-arm64']
    assert.ok(entry, 'expected node_modules/@img/sharp-linux-arm64 in the lockfile')
    assert.equal(entry.optional, true)
    assert.deepStrictEqual(entry.os, ['linux'])
    assert.deepStrictEqual(entry.cpu, ['arm64'])
    assert.ok(entry.resolved, 'expected a "resolved" tarball URL')
    assert.ok(entry.integrity, 'expected an "integrity" hash')
  })

  test('@img/sharp-libvips-linux-arm64 (the native libvips binary sharp links against) is present too', () => {
    const entry = packages['node_modules/@img/sharp-libvips-linux-arm64']
    assert.ok(entry, 'expected node_modules/@img/sharp-libvips-linux-arm64 in the lockfile')
    assert.equal(entry.optional, true)
    assert.deepStrictEqual(entry.os, ['linux'])
    assert.deepStrictEqual(entry.cpu, ['arm64'])
    assert.ok(entry.resolved, 'expected a "resolved" tarball URL')
    assert.ok(entry.integrity, 'expected an "integrity" hash')
  })

  test('sharp itself has no gypfile/native-compile fallback wired in this lockfile (it is a pure dispatcher)', () => {
    // sharp's own package has no hasInstallScript entry — only its per-platform @img/sharp-* and
    // @img/sharp-libvips-* optional dependencies carry the actual native .node binaries, and those
    // are plain optional-dependency resolution (npm picks the right one for the install platform),
    // never a node-gyp compile.
    const entry = packages['node_modules/sharp']
    assert.ok(entry, 'expected node_modules/sharp in the lockfile')
    assert.ok(!entry.hasInstallScript, 'sharp gained an install script — re-audit for arm64')
  })
})
