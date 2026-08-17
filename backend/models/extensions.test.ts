import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import type { ExtensionDefinition } from './extensions.ts'

/**
 * Task 661: `getExtensions()` used to only ever answer `isInstalled`/`isCompatible` — a module that
 * failed to load earlier in this process (e.g. Sharp choking mid page-render) stayed silently
 * "installed" in the list until an admin happened to click reinstall and saw the one-shot
 * `restartRequired` toast. `needsRestart` surfaces `hasLoadFailed()` on every list load instead, so the
 * warning is visible the moment the admin opens the page. `incompatibleReason` does the equivalent for
 * the "not compatible" case: instead of a bare refusal, it says which architecture/platform the
 * extension needs versus what `os.arch()`/`process.platform` actually report here.
 *
 * `WIKI.SERVERPATH` is pointed at an empty temp dir so `moduleExists()` (used by `isInstalled()`) has
 * somewhere real to `fs.access` against — every specifier below is fictional, so it always resolves to
 * "not installed", which these tests don't otherwise care about.
 */

let dir: string
let previousWiki: any
let extensionsModel: typeof import('./extensions.ts').extensions

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wikijs-extensions-test-'))
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    SERVERPATH: dir,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  }
  ;({ extensions: extensionsModel } = await import('./extensions.ts'))
})

after(async () => {
  ;(globalThis as any).WIKI = previousWiki
  await rm(dir, { recursive: true, force: true })
})

afterEach(() => {
  extensionsModel.definitions = []
  extensionsModel.loadFailures.clear()
})

const moduleDefinition = (overrides: Partial<ExtensionDefinition> = {}): ExtensionDefinition => ({
  key: 'fake-ext',
  title: 'Fake Extension',
  description: 'A fictional extension for tests.',
  detect: { type: 'module', value: 'fake-ext-package-xyz' },
  isInstallable: true,
  ...overrides
})

test('getExtensions() reports needsRestart: false when nothing has failed to load', async () => {
  extensionsModel.definitions = [moduleDefinition()]
  const [state] = await extensionsModel.getExtensions()
  assert.equal(state.needsRestart, false)
})

test('getExtensions() reports needsRestart: true once this process has failed to load the module — independent of any install attempt', async () => {
  const definition = moduleDefinition()
  extensionsModel.definitions = [definition]
  // -> Simulates a page render (or anything else) hitting the failed import, not a reinstall attempt
  extensionsModel.noteLoadFailure(definition.detect.value)

  const [state] = await extensionsModel.getExtensions()
  assert.equal(state.needsRestart, true)
})

test('getExtensions() reports incompatibleReason: null when the extension is compatible', async () => {
  extensionsModel.definitions = [moduleDefinition()]
  const [state] = await extensionsModel.getExtensions()
  assert.equal(state.isCompatible, true)
  assert.equal(state.incompatibleReason, null)
})

test('getExtensions() names the required architecture and what this server reports when architecture-incompatible', async () => {
  extensionsModel.definitions = [moduleDefinition({ architectures: ['some-fictional-arch'] })]
  const [state] = await extensionsModel.getExtensions()

  assert.equal(state.isCompatible, false)
  assert.match(state.incompatibleReason ?? '', /some-fictional-arch/)
  assert.match(state.incompatibleReason ?? '', new RegExp(os.arch()))
})

test('getExtensions() names the required platform and what this server reports when platform-incompatible', async () => {
  extensionsModel.definitions = [moduleDefinition({ platforms: ['some-fictional-platform'] })]
  const [state] = await extensionsModel.getExtensions()

  assert.equal(state.isCompatible, false)
  assert.match(state.incompatibleReason ?? '', /some-fictional-platform/)
  assert.match(state.incompatibleReason ?? '', new RegExp(process.platform))
})
