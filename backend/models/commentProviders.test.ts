import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `refreshFromDisk` is pointed at a throwaway fixture tree rather than the real `modules/comments`,
 * so nothing here depends on which providers actually ship.
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
        // -> Redundant with the `comments.ts` written below: either half of `isSelectable()` alone
        //    makes `alpha` activatable, so the tests here never trip the non-selectable refusal for
        //    a reason unrelated to what they cover.
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
    await fs.writeFile(path.join(modulesDir, 'beta', 'comments.ts'), 'export {}\n')
    // -> Stands in for the real native provider: selectable through `hasImplementation` alone, with
    //    no `codeTemplate` on its definition.
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
    // -> Neither `codeTemplate` nor a `comments.ts`: the non-selectable fixture.
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

    // -> Switching disables the previous provider but leaves its stored config, so flipping back
    //    later restores it as it was.
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
    // -> The return value goes straight back to the client as the PUT response, so it has to be
    //    masked without a caller asking for it.
    const activated = await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      apiKey: 'not-sensitive',
      secret: 'akismet-key-value'
    })
    assert.equal(activated?.config.secret, '********')
    assert.equal(activated?.config.apiKey, 'not-sensitive')

    // -> Unmasked by default: `setActiveProvider`'s own merge reads through here and needs the real
    //    value to preserve an untouched secret.
    const unmasked = await commentProvidersModel.getSiteProviderByModule(fixtures.siteId, 'alpha')
    assert.equal(unmasked?.config.secret, 'akismet-key-value')

    const maskedList = await commentProvidersModel.getSiteProviders(fixtures.siteId, { mask: true })
    assert.equal(maskedList.find((p) => p.module === 'alpha')!.config.secret, '********')
  })

  test('a PUT that echoes the mask back leaves the real stored secret unchanged', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    await commentProvidersModel.setActiveProvider(fixtures.siteId, 'alpha', {
      secret: 'original-akismet-key'
    })

    // -> An admin form resubmitting the mask it was shown, having only changed `apiKey`.
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
 * Unlike the suite above, `refreshFromDisk()` here points at this repo's own real
 * `modules/comments/`, so these assertions are about the shipped definitions. Disk reads only, hence
 * no database and a `CARDINAL` carrying nothing but `SERVERPATH` and a logger.
 */
describe('commentProviders (definition loading)', () => {
  let previousWiki: CardinalGlobal | undefined
  let commentProvidersModel: typeof import('./commentProviders.ts').commentProviders

  before(async () => {
    previousWiki = global.CARDINAL
    global.CARDINAL = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    } as unknown as CardinalGlobal
    ;({ commentProviders: commentProvidersModel } = await import('./commentProviders.ts'))
    await commentProvidersModel.refreshFromDisk()
  })

  after(() => {
    global.CARDINAL = previousWiki as CardinalGlobal
  })

  test('reads codeTemplate off each definition.yml, defaulting to false when absent', () => {
    const disqus = commentProvidersModel.definitions.find((d) => d.key === 'disqus')!
    const commento = commentProvidersModel.definitions.find((d) => d.key === 'commento')!
    const artalk = commentProvidersModel.definitions.find((d) => d.key === 'artalk')!
    const defaultProvider = commentProvidersModel.definitions.find((d) => d.key === 'default')!

    assert.equal(disqus.codeTemplate, true)
    assert.equal(commento.codeTemplate, true)
    assert.equal(artalk.codeTemplate, true)
    assert.equal(defaultProvider.codeTemplate, false)
  })

  test('all three external providers are available and selectable via codeTemplate', () => {
    for (const key of ['disqus', 'commento', 'artalk']) {
      const definition = commentProvidersModel.definitions.find((d) => d.key === key)!
      assert.equal(definition.hasImplementation, false, `${key} unexpectedly has an implementation`)
      assert.equal(definition.codeTemplate, true, `${key} did not declare codeTemplate: true`)
      assert.equal(definition.isAvailable, true, `${key} should declare isAvailable: true`)
      assert.equal(
        commentProvidersModel.isSelectable(definition),
        true,
        `${key} should be selectable -- codeTemplate grants selectability on its own (#3303)`
      )
    }
  })

  test('the default provider is selectable via hasImplementation, not codeTemplate', () => {
    const definition = commentProvidersModel.definitions.find((d) => d.key === 'default')!
    assert.equal(definition.hasImplementation, true)
    assert.equal(definition.codeTemplate, false)
    assert.equal(commentProvidersModel.isSelectable(definition), true)
  })

  test('a hypothetical provider with neither an implementation nor codeTemplate is not selectable', () => {
    assert.equal(
      commentProvidersModel.isSelectable({ hasImplementation: false, codeTemplate: false }),
      false
    )
  })

  test('a hypothetical provider with codeTemplate but no implementation is selectable', () => {
    assert.equal(
      commentProvidersModel.isSelectable({ hasImplementation: false, codeTemplate: true }),
      true
    )
  })

  test('backend/locales/en.json carries a codeTemplate-aware caption under admin.comments.*', async () => {
    const enJsonPath = path.join(import.meta.dirname, '..', 'locales', 'en.json')
    const enLocale = JSON.parse(await fs.readFile(enJsonPath, 'utf8'))
    const caption = enLocale['admin.comments.externalProviderNotice']

    assert.equal(typeof caption, 'string')
    assert.ok(caption.length > 0, 'caption must not be empty')
    // -> The caption has to tell an admin two things: the provider is external and client-embedded,
    //    and its embed is gated per reader on `read:comments`. Wording claiming page-view rendering
    //    is unimplemented would be false.
    assert.match(caption, /external/i)
    assert.match(caption, /read:comments|permission/i)
    assert.doesNotMatch(caption, /not.*(?:implement|support)/i)
  })
})
