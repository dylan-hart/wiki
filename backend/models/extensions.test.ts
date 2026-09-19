import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { load } from 'js-yaml'
import { buildInstallArgs, installRequest } from './extensions.ts'
import type { ExtensionDefinition } from './extensions.ts'

/**
 * `CARDINAL.SERVERPATH` is pointed at an empty temp dir so `moduleExists()` has somewhere real to
 * `fs.access` against — every specifier below is fictional, so it always resolves to "not
 * installed", which these tests don't otherwise care about.
 */

let dir: string
let previousWiki: any
let extensionsModel: typeof import('./extensions.ts').extensions

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-extensions-test-'))
  previousWiki = (globalThis as any).CARDINAL
  ;(globalThis as any).CARDINAL = {
    SERVERPATH: dir,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  }
  ;({ extensions: extensionsModel } = await import('./extensions.ts'))
})

after(async () => {
  ;(globalThis as any).CARDINAL = previousWiki
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
  // -> Stands in for a page render hitting the failed import, not a reinstall attempt
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
 * Guards the `architectures`/`platforms` restrictions written into the Sharp and Puppeteer
 * definitions against what those packages publish, so a version bump that silently drops one of
 * these lines fails a test instead of quietly letting an incompatible host through.
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
 * The description must name the concrete integration point Pandoc actually has here -- the
 * `convertToMarkdown()` subprocess and the formats it converts -- rather than promising an importer
 * in vague "coming eventually" language.
 */
describe('pandoc definition.yml description accuracy (Task 665, superseded by Feature 402)', () => {
  test('names the real integration point and the formats it backs, not a future promise', async () => {
    const raw = await readFile(
      path.join(import.meta.dirname, '..', 'modules', 'extensions', 'pandoc', 'definition.yml'),
      'utf8'
    )
    const definition = load(raw) as ExtensionDefinition

    assert.match(definition.description, /models\/import\.ts/i)
    assert.match(definition.description, /convertToMarkdown/i)
    assert.match(definition.description, /mediawiki/i)
  })
})

describe('package.json has no decorative allowScripts key (WP 2290)', () => {
  test('no allowScripts key while @lavamoat/allow-scripts is not a dependency', async () => {
    const raw = await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)

    assert.equal(
      Object.hasOwn(pkg, 'allowScripts'),
      false,
      'allowScripts is only read by @lavamoat/allow-scripts, which is not installed — see the ' +
        'install() doc comment in extensions.ts for the full rationale. If @lavamoat/allow-scripts ' +
        'is added as a real dependency, update this test alongside it.'
    )
    assert.equal(
      Object.hasOwn(pkg.devDependencies ?? {}, '@lavamoat/allow-scripts'),
      false,
      '@lavamoat/allow-scripts is not installed; if this ever changes, allowScripts becomes a real ' +
        'policy again and this assertion (and the one above it) should be updated together'
    )
  })
})

describe('install() argv locked to its documented flag policy (OpenProject #2291)', () => {
  // -> Sharp's shape: a declared optional dependency, so the manifest is the only version pin and
  //    the definition carries no `installVersion`.
  const declaredNoVersion = moduleDefinition({
    key: 'sharp',
    detect: { type: 'module', value: 'sharp' }
  })

  // -> Puppeteer's shape: declared in no manifest, so `installVersion` is its only version pin.
  const undeclaredPinned = moduleDefinition({
    key: 'puppeteer',
    detect: { type: 'module', value: 'puppeteer' },
    installVersion: '25.4.0'
  })

  test('requests the bare specifier when the extension carries no installVersion', () => {
    assert.equal(installRequest(declaredNoVersion), 'sharp')
  })

  test('requests specifier@version when the extension pins installVersion', () => {
    assert.equal(installRequest(undeclaredPinned), 'puppeteer@25.4.0')
  })

  test('builds the exact, fully-ordered argv for a declared/unversioned extension', () => {
    assert.deepEqual(buildInstallArgs(declaredNoVersion), [
      'install',
      '--no-save',
      '--force',
      '--include=optional',
      '--no-ignore-scripts',
      '--no-audit',
      '--no-fund',
      'sharp'
    ])
  })

  test('builds the exact, fully-ordered argv for an undeclared/version-pinned extension', () => {
    assert.deepEqual(buildInstallArgs(undeclaredPinned), [
      'install',
      '--no-save',
      '--force',
      '--include=optional',
      '--no-ignore-scripts',
      '--no-audit',
      '--no-fund',
      'puppeteer@25.4.0'
    ])
  })

  /**
   * Both directions: a flag the policy comment justifies but the code dropped fails here too, not
   * just the reverse. `--no-audit`/`--no-fund` are excluded as npm-noise suppressors the comment
   * deliberately does not justify one by one.
   */
  test('every flag the install() doc comment justifies is actually present in the built argv', async () => {
    const source = await readFile(path.join(import.meta.dirname, 'extensions.ts'), 'utf8')
    const docCommentMatch = source.match(/Hence the flags:\n([\s\S]*?)\*\/\n\s*async install/)
    assert.ok(
      docCommentMatch,
      'expected to find the "Hence the flags:" doc comment block above install()'
    )
    const docComment = docCommentMatch[1]

    const documentedFlags = ['--no-save', '--force', '--include=optional', '--no-ignore-scripts']
    const argv = buildInstallArgs(declaredNoVersion)
    for (const flag of documentedFlags) {
      assert.ok(docComment.includes(`\`${flag}\``), `expected the doc comment to justify ${flag}`)
      assert.ok(argv.includes(flag), `expected the built argv to include documented flag ${flag}`)
    }
  })
})
