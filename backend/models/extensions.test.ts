import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { load } from 'js-yaml'
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

/**
 * Task 664: guards the `architectures`/`platforms` restrictions actually written into the Sharp and
 * Puppeteer definitions against what those packages publish, so a version bump that silently drops one
 * of these lines fails a test instead of quietly letting an incompatible host through. See the
 * verification comments in each `definition.yml` for the registry/vendor source and date.
 */
describe('sharp and puppeteer definition.yml architecture/platform constraints (Task 664)', () => {
  const loadDefinition = async (key: string): Promise<ExtensionDefinition> => {
    const raw = await readFile(
      path.join(import.meta.dirname, '..', 'modules', 'extensions', key, 'definition.yml'),
      'utf8'
    )
    return load(raw) as ExtensionDefinition
  }

  test('sharp restricts architectures to x64/arm64 — its published binaries for glibc AND musl Linux, only cover these two', async () => {
    const definition = await loadDefinition('sharp')
    assert.deepEqual(definition.architectures, ['x64', 'arm64'])
  })

  test('sharp declares no platforms restriction — it publishes native builds for linux/darwin/win32 plus a wasm fallback for others', async () => {
    const definition = await loadDefinition('sharp')
    assert.equal(definition.platforms, undefined)
  })

  test('puppeteer restricts architectures to x64/arm64 — Chrome for Testing has no ia32 or loong64 build to download', async () => {
    const definition = await loadDefinition('puppeteer')
    assert.deepEqual(definition.architectures, ['x64', 'arm64'])
    assert.ok(!definition.architectures?.includes('ia32'))
    assert.ok(!definition.architectures?.includes('loong64'))
  })

  test('puppeteer restricts platforms to linux/darwin/win32 — @puppeteer/browsers cannot resolve a Chrome for Testing download on any other platform, and its postinstall throws rather than skipping', async () => {
    const definition = await loadDefinition('puppeteer')
    assert.deepEqual(definition.platforms, ['linux', 'darwin', 'win32'])
  })
})

/**
 * Task 665 caught `pandoc/definition.yml` describing Pandoc as "Required to import content from
 * other wikis and formats such as MediaWiki, AsciiDoc, Textile or DocBook" while no importer existed
 * anywhere under `backend/api` or `frontend/src` -- present tense claiming functionality that wasn't
 * there yet. Feature 402 (tasks 667/668) has since built that importer for real
 * (`models/import.ts`'s `convertToMarkdown()`, backed by a real `pandoc` subprocess -- see
 * `models/import.ts`). This now guards the opposite drift: the description must name the concrete
 * integration point it actually has, not regress to vague "coming eventually" language now that the
 * feature is real.
 */
describe('pandoc definition.yml description accuracy (Task 665, superseded by Feature 402)', () => {
  test('names the real integration point and the formats it backs, not a future promise', async () => {
    const raw = await readFile(
      path.join(import.meta.dirname, '..', 'modules', 'extensions', 'pandoc', 'definition.yml'),
      'utf8'
    )
    const definition = load(raw) as ExtensionDefinition

    // -> Traceable to the code path that actually calls pandoc, not just an epic that might one day.
    assert.match(definition.description, /models\/import\.ts/i)
    assert.match(definition.description, /convertToMarkdown/i)
    assert.match(definition.description, /mediawiki/i)
  })
})
