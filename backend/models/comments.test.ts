import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

/**
 * Task 645 (Feature 396): the comment-provider module loader (mirroring `StorageDefinition`/
 * `refreshFromDisk()` in `models/storage.ts`) must not gate "is this provider selectable" purely on
 * `hasImplementation`, the way `models/storage.ts` currently does. That pattern is harmless for
 * storage only because no storage module has shipped an implementation yet, so every target is
 * equally (and temporarily) unavailable. Disqus, Commento and Artalk are pure client-side embeds —
 * a shortname/instance URL handed to the vendor's own script — and were never going to get a
 * `comments.ts`, so the same gate would mark them *permanently* unselectable. `codeTemplate: true`
 * (declared on each of their `definition.yml`, Task 643) is the independent signal that lets a
 * provider be selectable without server-side code behind it.
 *
 * No `WIKI` global/database beyond `SERVERPATH` + a silent logger is needed: `refreshFromDisk()`
 * only reads disk, and points at this repo's own real `modules/comments/` directory (not a fixture)
 * so this test exercises the actual Disqus/Commento/Artalk/default definitions rather than stand-ins.
 */
describe('models/comments (definition loading)', () => {
  let previousWiki: any
  let comments: typeof import('./comments.ts').comments

  before(async () => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
    ;({ comments } = await import('./comments.ts'))
    await comments.refreshFromDisk()
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('reads codeTemplate off each definition.yml, defaulting to false when absent', () => {
    const disqus = comments.getDefinition('disqus')!
    const commento = comments.getDefinition('commento')!
    const artalk = comments.getDefinition('artalk')!
    const defaultProvider = comments.getDefinition('default')!

    assert.equal(disqus.codeTemplate, true)
    assert.equal(commento.codeTemplate, true)
    assert.equal(artalk.codeTemplate, true)
    // -> `default`'s definition.yml declares no `codeTemplate` key at all
    assert.equal(defaultProvider.codeTemplate, false)
  })

  test('all three external providers are selectable despite having no comments.ts', () => {
    for (const key of ['disqus', 'commento', 'artalk']) {
      const definition = comments.getDefinition(key)!
      assert.equal(definition.hasImplementation, false, `${key} unexpectedly has an implementation`)
      assert.equal(definition.codeTemplate, true, `${key} did not declare codeTemplate: true`)
      assert.equal(
        comments.isSelectable(definition),
        true,
        `${key} should be selectable via codeTemplate even without hasImplementation`
      )
    }
  })

  test('the default provider is selectable via hasImplementation, not codeTemplate', () => {
    const definition = comments.getDefinition('default')!
    assert.equal(definition.hasImplementation, true)
    assert.equal(definition.codeTemplate, false)
    assert.equal(comments.isSelectable(definition), true)
  })

  test('getDefinitions() includes codeTemplate and a pre-computed isSelectable for every provider', () => {
    const definitions = comments.getDefinitions()
    assert.equal(definitions.length, 4)

    const byKey = Object.fromEntries(definitions.map((d) => [d.key, d]))
    assert.deepEqual(
      {
        hasImplementation: byKey.disqus.hasImplementation,
        codeTemplate: byKey.disqus.codeTemplate,
        isSelectable: byKey.disqus.isSelectable
      },
      { hasImplementation: false, codeTemplate: true, isSelectable: true }
    )
    assert.deepEqual(
      {
        hasImplementation: byKey.default.hasImplementation,
        codeTemplate: byKey.default.codeTemplate,
        isSelectable: byKey.default.isSelectable
      },
      { hasImplementation: true, codeTemplate: false, isSelectable: true }
    )
  })

  /**
   * Task 649 (Feature 396): an admin picking Disqus/Commento/Artalk from the provider list must not
   * be misled into thinking comments will actually appear on pages -- this fork's page-view renderer
   * does not implement the `codeTemplate` embed path yet (only `default`'s server-rendered comments
   * do). `AdminComments.vue` is expected to show this caption whenever the selected provider has
   * `codeTemplate: true`; this test pins the locale string itself (existence + content) so the string
   * exists under `backend/locales/en.json`'s `admin.comments.*` namespace regardless of which branch's
   * copy of that Vue file ends up consuming it.
   */
  test('backend/locales/en.json carries a codeTemplate-aware caption under admin.comments.*', async () => {
    const enJsonPath = path.join(import.meta.dirname, '..', 'locales', 'en.json')
    const enLocale = JSON.parse(await readFile(enJsonPath, 'utf8'))
    const caption = enLocale['admin.comments.externalProviderNotice']

    assert.equal(typeof caption, 'string')
    assert.ok(caption.length > 0, 'caption must not be empty')
    // -> Must actually communicate the two things an admin needs to know: that this is an external,
    //    client-embedded provider, and that page-view rendering for it isn't implemented yet
    assert.match(caption, /external/i)
    assert.match(caption, /not.*(?:implement|support)/i)
  })

  test('a hypothetical provider with neither hasImplementation nor codeTemplate is not selectable', () => {
    assert.equal(
      comments.isSelectable({
        key: 'hypothetical',
        title: 'Hypothetical',
        description: '',
        website: '',
        isAvailable: true,
        props: {},
        codeTemplate: false,
        hasImplementation: false
      }),
      false
    )
  })
})
