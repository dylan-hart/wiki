/**
 * Runs against a real, migrated Postgres because what is under test IS the row round trip: a target
 * row seeded by `syncSite`, its stored secrets masked on read and preserved on write.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { storage } from './storage.ts'

before(() => ensureTemporal())

describe(
  'storage / hasImplementation, getSiteTargets, executeAction wiring (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> `test/db.ts` computes `SERVERPATH` from `process.cwd()`, which is wrong when the runner
      //    is launched from `backend/` — this repo's convention. The dynamic module import below
      //    resolves against it, so it is repointed here.
      CARDINAL.SERVERPATH = path.join(import.meta.dirname, '..')
      await storage.refreshFromDisk()
      await storage.syncSite(fixtures.siteId)
    })

    after(async () => {
      await teardownTestDb()
    })

    test('hasImplementation() flips true for s3, azure, gcs and sftp', () => {
      assert.equal(storage.getDefinition('s3')?.hasImplementation, true)
      assert.equal(storage.getDefinition('azure')?.hasImplementation, true)
      assert.equal(storage.getDefinition('gcs')?.hasImplementation, true)
      // -> Every module under modules/storage ships a real storage.ts, so there is no config-only
      //    module to assert `false` against.
      assert.equal(storage.getDefinition('sftp')?.hasImplementation, true)
    })

    test('getSiteTargets() exposes the exportAll action for s3/azure/gcs/sftp', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      for (const key of ['s3', 'azure', 'gcs', 'sftp']) {
        const target = targets.find((t) => t.module === key)
        assert.ok(target, `expected a ${key} target row`)
        assert.ok(
          target!.actions.some((a) => a.handler === 'exportAll'),
          `expected ${key}'s actions to include exportAll`
        )
      }
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
      // -> Spied rather than real: `executeAction` is under test here, not the s3 SDK.
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

    test('a sensitive prop (sftp password) never leaves a masked getSiteTargets() read', async () => {
      let targets = await storage.getSiteTargets(fixtures.siteId)
      const sftpTarget = targets.find((t) => t.module === 'sftp')!
      const invalid = await storage.validateTarget(sftpTarget, {
        id: sftpTarget.id,
        config: { authMode: 'password', password: 'super-secret-password' }
      })
      assert.equal(invalid, null)
      assert.equal(
        await storage.updateTarget(fixtures.siteId, sftpTarget, {
          id: sftpTarget.id,
          config: { authMode: 'password', password: 'super-secret-password' }
        }),
        true
      )

      // -> Unmasked by default: every internal caller needs the real value.
      targets = await storage.getSiteTargets(fixtures.siteId)
      assert.equal(
        targets.find((t) => t.module === 'sftp')!.config.password,
        'super-secret-password'
      )

      // -> `{ mask: true }`: what the admin GET route returns to the client.
      const maskedTargets = await storage.getSiteTargets(fixtures.siteId, { mask: true })
      const maskedSftp = maskedTargets.find((t) => t.module === 'sftp')!
      assert.equal(maskedSftp.config.password, '********')
      assert.equal(maskedSftp.config.authMode, 'password')
    })

    test('a PUT that echoes the mask back leaves the real stored secret unchanged', async () => {
      let targets = await storage.getSiteTargets(fixtures.siteId)
      const sftpTarget = targets.find((t) => t.module === 'sftp')!
      await storage.updateTarget(fixtures.siteId, sftpTarget, {
        id: sftpTarget.id,
        config: { authMode: 'password', password: 'original-secret' }
      })

      // -> An admin form resubmitting the masked value it was shown, having only changed an
      //    unrelated field.
      targets = await storage.getSiteTargets(fixtures.siteId)
      const current = targets.find((t) => t.module === 'sftp')!
      await storage.updateTarget(fixtures.siteId, current, {
        id: current.id,
        config: { authMode: 'password', password: '********', basePath: '/data/wiki' }
      })

      targets = await storage.getSiteTargets(fixtures.siteId)
      const updated = targets.find((t) => t.module === 'sftp')!
      assert.equal(updated.config.password, 'original-secret')
      assert.equal(updated.config.basePath, '/data/wiki')
    })
  }
)

describe(
  'storage / assetDelivery.readThrough seeding (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      CARDINAL.SERVERPATH = path.join(import.meta.dirname, '..')
      await storage.refreshFromDisk()
      await storage.syncSite(fixtures.siteId)
    })

    after(async () => {
      await teardownTestDb()
    })

    test('a freshly seeded blob target has readThrough off and its supported flag on', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      for (const key of ['s3', 'azure', 'gcs']) {
        const target = targets.find((t) => t.module === key)!
        assert.equal(target.assetDelivery.isReadThroughSupported, true, key)
        assert.equal(target.assetDelivery.readThrough, false, key)
      }
    })

    test('readThrough round-trips through the row for a blob target and stays off for db', async () => {
      let targets = await storage.getSiteTargets(fixtures.siteId)
      const s3 = targets.find((t) => t.module === 's3')!
      await storage.updateTarget(fixtures.siteId, s3, {
        id: s3.id,
        assetDelivery: { readThrough: true }
      })
      const db = targets.find((t) => t.module === 'db')!
      await storage.updateTarget(fixtures.siteId, db, {
        id: db.id,
        assetDelivery: { readThrough: true }
      })

      targets = await storage.getSiteTargets(fixtures.siteId)
      assert.equal(targets.find((t) => t.module === 's3')!.assetDelivery.readThrough, true)
      assert.equal(targets.find((t) => t.module === 'db')!.assetDelivery.readThrough, false)
    })
  }
)
