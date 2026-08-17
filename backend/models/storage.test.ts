import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import path from 'node:path'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { storage } from './storage.ts'

/**
 * Task 545: confirm end-to-end that the three cloud module `storage.ts` files landed by tasks
 * 540/541/544 are actually wired through `models/storage.ts` — `hasImplementation()` flips true,
 * `getSiteTargets()` exposes their `exportAll` action, and `executeAction()` genuinely dispatches to a
 * module's handler — plus the config-validation edge cases `validateConfig`/`validateTarget` already
 * enforce that a cloud target's props exercise (e.g. s3's mode-gated enums).
 */

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

describe('storage / validateConfig, validateTarget (pure, real s3 definition read from disk)', () => {
  before(async () => {
    // -> A plain `fs.readdir`/`fs.readFile` under `modules/storage`, no database — the one thing it
    //    needs from `WIKI` is `SERVERPATH` pointed at this checkout's real `backend/` directory.
    ;(globalThis as any).WIKI = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: silentLogger
    }
    await storage.refreshFromDisk()
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('the s3 definition loaded for real, with its declared props intact', () => {
    const definition = storage.getDefinition('s3')
    assert.ok(definition, 'expected modules/storage/s3/definition.yml to have loaded')
    assert.ok(definition!.props.mode, 'expected a `mode` prop')
    assert.ok(definition!.props.awsRegion, 'expected an `awsRegion` prop')
  })

  test('an invalid enum value for `mode` is rejected with a readable message', () => {
    const invalid = storage.validateConfig('s3', { mode: 'gcp' })
    assert.match(invalid ?? '', /"gcp" is not a valid value for Mode/)
  })

  test('a mode-gated enum prop is still validated against its own enum regardless of the current mode', () => {
    // -> `awsRegion` is only shown in the admin area `if mode eq aws` (definition.yml), but
    //    `validateConfig` has no notion of that UI gate — it validates every incoming key against its
    //    own prop declaration, so a bogus `awsRegion` is refused even while `mode` is `do`. This is the
    //    "s3's mode-gated props" edge case task 545 calls out explicitly.
    const invalid = storage.validateConfig('s3', { mode: 'do', awsRegion: 'mars-central-1' })
    assert.match(invalid ?? '', /"mars-central-1" is not a valid value for Region/)
  })

  test('a boolean prop refuses a non-boolean value', () => {
    const invalid = storage.validateConfig('s3', { s3ForcePathStyle: 'true' })
    assert.match(invalid ?? '', /Force Path Style for S3 objects must be true or false/)
  })

  test('an unknown key is silently accepted (dropped by buildConfig, not refused here)', () => {
    assert.equal(storage.validateConfig('s3', { notARealProp: 'whatever' }), null)
  })

  test('a fully valid aws-mode config passes', () => {
    assert.equal(
      storage.validateConfig('s3', {
        mode: 'aws',
        awsRegion: 'us-east-1',
        bucket: 'my-bucket',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        storageTier: 'STANDARD'
      }),
      null
    )
  })

  test('validateTarget rejects an unknown content type', () => {
    const definition = storage.getDefinition('s3')!
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: definition.title,
      contentTypes: { activeTypes: [], largeThreshold: '5MB' },
      setup: undefined
    } as any
    const invalid = storage.validateTarget(target, {
      id: 't1',
      contentTypes: { activeTypes: ['videos'] }
    })
    assert.match(invalid ?? '', /"videos" is not a valid content type/)
  })

  test('validateTarget rejects a malformed largeThreshold', () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: [], largeThreshold: '5MB' },
      setup: undefined
    } as any
    const invalid = storage.validateTarget(target, {
      id: 't1',
      contentTypes: { largeThreshold: 'huge' }
    })
    assert.match(invalid ?? '', /"huge" is not a valid size threshold/)
  })

  test('validateTarget accepts enabling an s3 target directly — it declares no setup process to gate on', () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' },
      setup: undefined
    } as any
    assert.equal(storage.validateTarget(target, { id: 't1', isEnabled: true }), null)
  })
})

describe(
  'storage / hasImplementation, getSiteTargets, executeAction wiring (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> `test/db.ts` computes `SERVERPATH` as `path.join(process.cwd(), 'backend')`, which is
      //    correct when the process is launched from the repo root but not from `backend/` itself —
      //    this repo's convention (CLAUDE.md: "Run backend commands from backend/") is the latter.
      //    Repointed here rather than in the shared fixture, which is owned by a different feature.
      WIKI.SERVERPATH = path.join(import.meta.dirname, '..')
      await storage.refreshFromDisk()
      await storage.syncSite(fixtures.siteId)
    })

    after(async () => {
      await teardownTestDb()
    })

    test('hasImplementation() flips true for s3, azure and gcs, and stays false for a config-only module', () => {
      assert.equal(storage.getDefinition('s3')?.hasImplementation, true)
      assert.equal(storage.getDefinition('azure')?.hasImplementation, true)
      assert.equal(storage.getDefinition('gcs')?.hasImplementation, true)
      // -> sftp ships only a definition.yml, no storage.ts — the contrast case proving the flip is a
      //    real disk check and not a constant true.
      assert.equal(storage.getDefinition('sftp')?.hasImplementation, false)
    })

    test('getSiteTargets() exposes the exportAll action for s3/azure/gcs, and none for sftp', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      for (const key of ['s3', 'azure', 'gcs']) {
        const target = targets.find((t) => t.module === key)
        assert.ok(target, `expected a ${key} target row`)
        assert.ok(
          target!.actions.some((a) => a.handler === 'exportAll'),
          `expected ${key}'s actions to include exportAll`
        )
      }
      const sftpTarget = targets.find((t) => t.module === 'sftp')
      assert.ok(sftpTarget, 'expected an sftp target row')
      assert.deepEqual(sftpTarget!.actions, [])
    })

    test('ensureModule() dynamically loads the real s3 module through the extension-sensitive import path', async () => {
      const mod = await storage.ensureModule('s3')
      assert.ok(mod, 'expected the s3 module to load')
      assert.equal(typeof mod!.exportAll, 'function')
      assert.equal(typeof mod!.assetUploaded, 'function')
      assert.equal(typeof mod!.assetDeleted, 'function')
      assert.equal(typeof mod!.assetRenamed, 'function')
    })

    test('executeAction() dispatches to the module handler with the target it was given', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      const s3Target = targets.find((t) => t.module === 's3')!

      let calledWith: any
      // -> Swap the cached implementation for a spy: `executeAction` is what's under test here, not
      //    the s3 SDK itself (covered separately by `modules/storage/s3/storage.emulated.test.ts`
      //    against a real S3-compatible server).
      storage.modules.s3 = {
        exportAll: async (target: any) => {
          calledWith = target
        }
      }

      await storage.executeAction(s3Target, 'exportAll')

      assert.equal(calledWith.id, s3Target.id)
      assert.equal(calledWith.module, 's3')
      assert.equal(calledWith.siteId, fixtures.siteId)
    })

    test('executeAction() rejects a handler the module does not implement, with a readable message', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      const s3Target = targets.find((t) => t.module === 's3')!
      storage.modules.s3 = {}

      await assert.rejects(
        () => storage.executeAction(s3Target, 'exportAll'),
        /does not implement "exportAll"/
      )
    })
  }
)
