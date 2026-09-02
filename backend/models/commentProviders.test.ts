import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * Covers this task's own logic (617, Feature 394): discovering comment provider modules from disk,
 * giving a site one row per module (`syncSite`), and the "at most one active provider" invariant
 * `setActiveProvider` is responsible for. `refreshFromDisk` is pointed at a throwaway fixture tree
 * rather than the real `modules/comments` — no comments module ships on this branch yet (Feature 390
 * owns the default one, built independently on a sibling branch not yet merged here), and this suite
 * should keep passing unmodified once one lands, since it never depends on which modules are real.
 */
describe('commentProviders (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let commentProvidersModel: typeof import('./commentProviders.ts').commentProviders
  let modulesDir: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ commentProviders: commentProvidersModel } = await import('./commentProviders.ts'))

    modulesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-comments-modules-'))
    await fs.mkdir(path.join(modulesDir, 'alpha'), { recursive: true })
    await fs.writeFile(
      path.join(modulesDir, 'alpha', 'definition.yml'),
      [
        'key: alpha',
        'title: Alpha Provider',
        'description: A fixture provider.',
        "icon: ''",
        'vendor: Test',
        "website: ''",
        'isAvailable: true',
        // -> `codeTemplate: true` is descriptive only -- since OpenProject #1958 it no longer grants
        //    selectability on its own (see `isSelectable()`'s doc comment). This fixture is selectable
        //    because it also gets its own `comments.ts` below, same as the real native `default`
        //    provider does and the `default` fixture further down does too -- otherwise the
        //    OpenProject #1962 guard added to `setActiveProvider` would refuse every activation this
        //    describe block's other tests rely on, for a reason unrelated to what those tests cover.
        'codeTemplate: true',
        'props:',
        '  apiKey:',
        '    type: String',
        "    default: ''",
        '    title: API Key',
        '  secret:',
        '    type: String',
        "    default: ''",
        '    title: Secret Key',
        '    sensitive: true'
      ].join('\n')
    )
    await fs.writeFile(path.join(modulesDir, 'alpha', 'comments.ts'), 'export {}\n')
    await fs.mkdir(path.join(modulesDir, 'beta'), { recursive: true })
    await fs.writeFile(
      path.join(modulesDir, 'beta', 'definition.yml'),
      [
        'key: beta',
        'title: Beta Provider',
        'description: Another fixture provider.',
        "icon: ''",
        'vendor: Test',
        "website: ''",
        'isAvailable: true',
        'codeTemplate: true',
        'props: {}'
      ].join('\n')
    )
    // -> Selectable for the same reason as `alpha` above: its own `comments.ts`, not `codeTemplate`.
    await fs.writeFile(path.join(modulesDir, 'beta', 'comments.ts'), 'export {}\n')
    // -> Stands in for the real `default` provider: the only fixture module here with an actual
    //    `comments.ts` next to it, so `hasImplementation` is true and it is selectable on that basis
    //    alone, the same way the real native provider is.
    await fs.mkdir(path.join(modulesDir, 'default'), { recursive: true })
    await fs.writeFile(
      path.join(modulesDir, 'default', 'definition.yml'),
      [
        'key: default',
        'title: Default Provider',
        'description: A fixture native provider.',
        "icon: ''",
        'vendor: Test',
        "website: ''",
        'isAvailable: true',
        'props: {}'
      ].join('\n')
    )
    await fs.writeFile(path.join(modulesDir, 'default', 'comments.ts'), 'export {}\n')
    // -> Declares neither `codeTemplate` nor a `comments.ts` -- not selectable, for the write-refusal
    //    test below.
    await fs.mkdir(path.join(modulesDir, 'gamma'), { recursive: true })
    await fs.writeFile(
      path.join(modulesDir, 'gamma', 'definition.yml'),
      [
        'key: gamma',
        'title: Gamma Provider',
        'description: A fixture non-selectable provider.',
        "icon: ''",
        'vendor: Test',
        "website: ''",
        'isAvailable: true',
        'props: {}'
      ].join('\n')
    )

    await commentProvidersModel.refreshFromDisk(modulesDir)
  })

  after(async () => {
    await teardownTestDb()
    await fs.rm(modulesDir, { recursive: true, force: true })
  })

  test('refreshFromDisk discovers every module, alphabetically by title', () => {
    assert.deepEqual(
      commentProvidersModel.definitions.map((d) => d.key),
      ['alpha', 'beta', 'default', 'gamma']
    )
  })

  test('syncSite creates one disabled row per discovered module, config defaulted from props', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    const providers = await commentProvidersModel.getSiteProviders(fixtures.siteId)

    assert.deepEqual(
      providers.map((p) => ({ module: p.module, isEnabled: p.isEnabled })),
      [
        { module: 'alpha', isEnabled: false },
        { module: 'beta', isEnabled: false },
        { module: 'default', isEnabled: false },
        { module: 'gamma', isEnabled: false }
      ]
    )
    assert.deepEqual(providers[0]!.config, { apiKey: '', secret: '' })
  })

  test('setActiveProvider enables exactly one provider, disabling every other one for that site', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)

    const activated = await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      apiKey: 'secret-value'
    })
    assert.equal(activated?.module, 'alpha')
    assert.equal(activated?.isEnabled, true)
    assert.equal(activated?.config.apiKey, 'secret-value')

    let providers = await commentProvidersModel.getSiteProviders(fixtures.siteId)
    assert.deepEqual(
      providers.map((p) => ({ module: p.module, isEnabled: p.isEnabled })),
      [
        { module: 'alpha', isEnabled: true },
        { module: 'beta', isEnabled: false },
        { module: 'default', isEnabled: false },
        { module: 'gamma', isEnabled: false }
      ]
    )

    // -> Switching the active provider disables the previous one, and leaves its stored config
    //    untouched rather than wiping it — flipping back later restores it as it was.
    await commentProvidersModel.setActiveProvider(fixtures.siteId, 'beta', {})
    providers = await commentProvidersModel.getSiteProviders(fixtures.siteId)
    assert.deepEqual(
      providers.map((p) => ({ module: p.module, isEnabled: p.isEnabled })),
      [
        { module: 'alpha', isEnabled: false },
        { module: 'beta', isEnabled: true },
        { module: 'default', isEnabled: false },
        { module: 'gamma', isEnabled: false }
      ]
    )
    assert.equal(providers[0]!.config.apiKey, 'secret-value')
  })

  test('setActiveProvider rejects a config value of the wrong type, writing nothing', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    await assert.rejects(
      () => commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', { apiKey: 12345 }),
      /API Key must be a string/
    )
  })

  test('setActiveProvider returns null for a module nothing on disk declares', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    const result = await commentProvidersModel.setActiveProvider(fixtures.siteId, 'ghost', {})
    assert.equal(result, null)
  })

  /**
   * OpenProject #1962: a site's stored comment provider must never become a dead end -- the write
   * side (refusing to ever store a non-selectable module) and the read side (resolving a stored
   * provider that became non-selectable after the fact back to something that renders) are both
   * covered here.
   */
  test('setActiveProvider refuses to activate a non-selectable module, storing nothing', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', { apiKey: 'keep-me' })

    await assert.rejects(
      () => commentProvidersModel.setActiveProvider(fixtures.siteId, 'gamma', {}),
      /cannot be activated/i
    )

    const providers = await commentProvidersModel.getSiteProviders(fixtures.siteId)
    assert.equal(providers.find((p) => p.module === 'alpha')!.isEnabled, true)
    assert.equal(providers.find((p) => p.module === 'gamma')!.isEnabled, false)
  })

  test('a sensitive prop (secret) never leaves a config read, masked or via the PUT response', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    // -> `setActiveProvider`'s own return value is what `PUT .../comments/providers` sends straight
    //    back to the client, so it must come back masked without a caller having to ask for it.
    const activated = await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      apiKey: 'not-sensitive',
      secret: 'akismet-key-value'
    })
    assert.equal(activated?.config.secret, '********')
    // -> A non-sensitive prop on the same provider is untouched.
    assert.equal(activated?.config.apiKey, 'not-sensitive')

    // -> Default (unmasked): `setActiveProvider`'s own internal merge reads through this method, and
    //    needs the real value to preserve an untouched secret correctly.
    const unmasked = await commentProvidersModel.getSiteProviderByModule(fixtures.siteId, 'alpha')
    assert.equal(unmasked?.config.secret, 'akismet-key-value')

    // -> `{ mask: true }`: what the admin GET route (api/comments.ts) actually returns.
    const maskedList = await commentProvidersModel.getSiteProviders(fixtures.siteId, { mask: true })
    assert.equal(maskedList.find((p) => p.module === 'alpha')!.config.secret, '********')
  })

  test('a PUT that echoes the mask back leaves the real stored secret unchanged', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      secret: 'original-akismet-key'
    })

    // -> Simulates an admin form resubmitting the masked value it was shown, having only changed an
    //    unrelated field (apiKey) -- the secret field itself was never touched.
    await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      apiKey: 'changed-value',
      secret: '********'
    })

    const current = await commentProvidersModel.getSiteProviderByModule(fixtures.siteId, 'alpha')
    assert.equal(current?.config.secret, 'original-akismet-key')
    assert.equal(current?.config.apiKey, 'changed-value')
  })
})

/**
 * `codeTemplate`/`hasImplementation`/`isSelectable` (OpenProject #1958): `isSelectable()` now gates
 * purely on `hasImplementation`, matching `models/storage.ts`'s equivalent gate for storage targets.
 * An earlier version (Feature 396) treated `codeTemplate: true` (declared on each of Disqus/Commento/
 * Artalk's `definition.yml`) as an independent grant, so a provider with no server-side
 * implementation could still be selected on the theory that a future page-view render path would
 * embed the vendor's own client-side script. No such render path was ever built, and the three
 * providers now declare `isAvailable: false` instead (see the "Comment provider selectability" entry
 * in `docs/variances.md` for the full reversal) -- `codeTemplate` remains a descriptive field on the
 * definition (still read off disk below), it just no longer feeds `isSelectable()`.
 *
 * No `WIKI` global/database beyond `SERVERPATH` + a silent logger is needed: `refreshFromDisk()` only
 * reads disk, and points at this repo's own real `modules/comments/` directory (not a fixture) so
 * this test exercises the actual Disqus/Commento/Artalk/default definitions rather than stand-ins.
 */
describe('commentProviders (definition loading)', () => {
  let previousWiki: WikiGlobal | undefined
  let commentProvidersModel: typeof import('./commentProviders.ts').commentProviders

  before(async () => {
    previousWiki = global.WIKI
    global.WIKI = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    } as unknown as WikiGlobal
    ;({ commentProviders: commentProvidersModel } = await import('./commentProviders.ts'))
    await commentProvidersModel.refreshFromDisk()
  })

  after(() => {
    global.WIKI = previousWiki as WikiGlobal
  })

  test('reads codeTemplate off each definition.yml, defaulting to false when absent', () => {
    const disqus = commentProvidersModel.definitions.find((d) => d.key === 'disqus')!
    const commento = commentProvidersModel.definitions.find((d) => d.key === 'commento')!
    const artalk = commentProvidersModel.definitions.find((d) => d.key === 'artalk')!
    const defaultProvider = commentProvidersModel.definitions.find((d) => d.key === 'default')!

    assert.equal(disqus.codeTemplate, true)
    assert.equal(commento.codeTemplate, true)
    assert.equal(artalk.codeTemplate, true)
    // -> `default`'s definition.yml declares no `codeTemplate` key at all
    assert.equal(defaultProvider.codeTemplate, false)
  })

  test('all three external providers are unavailable and not selectable despite declaring codeTemplate', () => {
    for (const key of ['disqus', 'commento', 'artalk']) {
      const definition = commentProvidersModel.definitions.find((d) => d.key === key)!
      assert.equal(definition.hasImplementation, false, `${key} unexpectedly has an implementation`)
      assert.equal(definition.codeTemplate, true, `${key} did not declare codeTemplate: true`)
      assert.equal(definition.isAvailable, false, `${key} should declare isAvailable: false`)
      assert.equal(
        commentProvidersModel.isSelectable(definition),
        false,
        `${key} should not be selectable -- codeTemplate no longer grants selectability on its own`
      )
    }
  })

  test('the default provider is selectable via hasImplementation', () => {
    const definition = commentProvidersModel.definitions.find((d) => d.key === 'default')!
    assert.equal(definition.hasImplementation, true)
    assert.equal(definition.codeTemplate, false)
    assert.equal(commentProvidersModel.isSelectable(definition), true)
  })

  test('a hypothetical provider with no implementation is not selectable, codeTemplate notwithstanding', () => {
    assert.equal(commentProvidersModel.isSelectable({ hasImplementation: false }), false)
  })

  test('backend/locales/en.json carries a codeTemplate-aware caption under admin.comments.*', async () => {
    const enJsonPath = path.join(import.meta.dirname, '..', 'locales', 'en.json')
    const enLocale = JSON.parse(await fs.readFile(enJsonPath, 'utf8'))
    const caption = enLocale['admin.comments.externalProviderNotice']

    assert.equal(typeof caption, 'string')
    assert.ok(caption.length > 0, 'caption must not be empty')
    // -> Must actually communicate the two things an admin needs to know: that this is an external,
    //    client-embedded provider, and that page-view rendering for it isn't implemented yet
    assert.match(caption, /external/i)
    assert.match(caption, /not.*(?:implement|support)/i)
  })
})
