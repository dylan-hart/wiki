/**
 * `models/storage.ts`'s database-backed half: which modules ship an implementation, what
 * `getSiteTargets()` reads back for a site, and how `executeAction` is wired to a target — run
 * against a real, migrated Postgres, because what is under test IS the row round trip (a target row
 * seeded by `syncSite`, its stored secrets masked on read and preserved on write).
 *
 * Lifted out of `models/storage.test.ts` (TEST-F14/TEST-F16), which was 52 describes of pure unit
 * tests around this one DB-backed block — the extreme case the survey names. The pure/DB boundary is
 * a filename property now, so a reader (and a `node --test` invocation with no `DATABASE_URL`) can
 * tell the two apart without opening either.
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

    test('hasImplementation() flips true for s3, azure, gcs and sftp', () => {
      assert.equal(storage.getDefinition('s3')?.hasImplementation, true)
      assert.equal(storage.getDefinition('azure')?.hasImplementation, true)
      assert.equal(storage.getDefinition('gcs')?.hasImplementation, true)
      // -> Tasks 521/522/523 gave sftp a real storage.ts too (connection.ts + pages.ts + assets.ts,
      //    orchestrated by exportAll) -- it is no longer the config-only contrast case it once was.
      //    Every module under modules/storage now ships a real storage.ts (see CLAUDE.md's
      //    `modules/` section), so there is no remaining config-only module to assert `false`
      //    against here.
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

      // -> Default (unmasked): every internal caller (dispatch/executeAction/backups) needs
      //    the real value, so it must still be there.
      targets = await storage.getSiteTargets(fixtures.siteId)
      assert.equal(
        targets.find((t) => t.module === 'sftp')!.config.password,
        'super-secret-password'
      )

      // -> `{ mask: true }`: what the admin GET route actually returns to the client.
      const maskedTargets = await storage.getSiteTargets(fixtures.siteId, { mask: true })
      const maskedSftp = maskedTargets.find((t) => t.module === 'sftp')!
      assert.equal(maskedSftp.config.password, '********')
      // -> A non-sensitive prop on the same target is untouched by masking.
      assert.equal(maskedSftp.config.authMode, 'password')
    })

    test('a PUT that echoes the mask back leaves the real stored secret unchanged', async () => {
      let targets = await storage.getSiteTargets(fixtures.siteId)
      const sftpTarget = targets.find((t) => t.module === 'sftp')!
      await storage.updateTarget(fixtures.siteId, sftpTarget, {
        id: sftpTarget.id,
        config: { authMode: 'password', password: 'original-secret' }
      })

      // -> Simulates an admin form resubmitting the masked value it was shown, having only changed
      //    an unrelated field (basePath) -- the password field itself was never touched.
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
