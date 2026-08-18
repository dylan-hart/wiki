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
        'props:',
        '  apiKey:',
        '    type: String',
        "    default: ''",
        '    title: API Key'
      ].join('\n')
    )
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
      ['alpha', 'beta']
    )
  })

  test('syncSite creates one disabled row per discovered module, config defaulted from props', async () => {
    await commentProvidersModel.syncSite(fixtures.siteId)
    const providers = await commentProvidersModel.getSiteProviders(fixtures.siteId)

    assert.deepEqual(
      providers.map((p) => ({ module: p.module, isEnabled: p.isEnabled })),
      [
        { module: 'alpha', isEnabled: false },
        { module: 'beta', isEnabled: false }
      ]
    )
    assert.deepEqual(providers[0]!.config, { apiKey: '' })
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
        { module: 'beta', isEnabled: false }
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
        { module: 'beta', isEnabled: true }
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
})
