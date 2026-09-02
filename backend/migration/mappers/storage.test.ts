import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  KNOWN_3_0_STORAGE_MODULES,
  mapStorageRow,
  mapStorageRows,
  type SourceStorageRow
} from './storage.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `mapStorageRow(s)` (task 767) tests.
 *
 * The resolver under test is the *real* `WIKI.models.storage` singleton, not a hand-rolled fake —
 * same reasoning as the `authentication` mapper's test (task 765): this suite boots the minimal
 * slice of `WIKI` that `getDefinition`/`buildConfig`/`validateConfig` actually touch
 * (`WIKI.SERVERPATH`, `WIKI.logger`), populated by the real `refreshFromDisk()` reading the real
 * `backend/modules/storage/*\/definition.yml` files straight off disk. None of the three methods
 * this mapper calls touches `WIKI.db`, so this needs no database.
 */

let wikiHandle: { restore(): void }

before(async () => {
  await ensureTemporal()
  wikiHandle = installTestWiki({ SERVERPATH: path.join(import.meta.dirname, '..', '..') })
  const { storage } = await import('../../models/storage.ts')
  await storage.refreshFromDisk()
  assert.ok(
    storage.definitions.length > 0,
    'refreshFromDisk should have loaded the real on-disk module definitions'
  )
})

after(() => {
  wikiHandle.restore()
})

async function resolver() {
  return (await import('../../models/storage.ts')).storage
}

function baseRow(overrides: Partial<SourceStorageRow> = {}): SourceStorageRow {
  return {
    key: 'disk',
    isEnabled: true,
    mode: 'push',
    config: {},
    syncInterval: null,
    state: {},
    ...overrides
  }
}

const SITE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SITE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

describe('KNOWN_3_0_STORAGE_MODULES', () => {
  test('matches the real backend/modules/storage/ directory listing exactly', async () => {
    const storagePath = path.join(import.meta.dirname, '..', '..', 'modules', 'storage')
    const onDisk = (await fs.readdir(storagePath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual([...KNOWN_3_0_STORAGE_MODULES].sort(), onDisk)
  })
})

describe('mapStorageRow: unsupported source keys', () => {
  for (const key of ['box', 'digitalocean', 'dropbox', 'gdrive', 'onedrive', 's3generic']) {
    test(`'${key}' (no matching 3.0 module directory) comes back unsupported, no update written`, async () => {
      const result = mapStorageRow(baseRow({ key }), { resolver: await resolver(), siteId: SITE_A })
      assert.equal(result.status, 'unsupported')
      assert.equal(result.update, undefined)
      assert.match(result.message!, /no matching 3\.0 module directory/)
    })
  }

  test('a key that is not even in the enumerated list is unsupported without consulting the resolver', async () => {
    const result = mapStorageRow(baseRow({ key: 'totally-made-up' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'unsupported')
  })
})

describe('mapStorageRow: mode/syncInterval mapping', () => {
  test('mode maps straight across as syncMode when the module supports it, syncInterval already ISO-8601 passes through as scheduleOverride', async () => {
    const result = mapStorageRow(baseRow({ key: 'git', mode: 'sync', syncInterval: 'PT5M' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.values.syncMode, 'sync')
    assert.equal(result.update!.values.scheduleOverride, 'PT5M')
    assert.equal(result.droppedFields, undefined)
  })

  test('a cron "every N minutes" syncInterval converts to an ISO-8601 duration', async () => {
    const result = mapStorageRow(baseRow({ key: 'git', syncInterval: '*/15 * * * *' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.update!.values.scheduleOverride, 'PT15M')
  })

  test('a cron "every N hours" syncInterval converts to an ISO-8601 duration', async () => {
    const result = mapStorageRow(baseRow({ key: 'git', syncInterval: '0 */3 * * *' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.update!.values.scheduleOverride, 'PT3H')
  })

  test('a mode the target module does not support is dropped and reported, not written', async () => {
    // -> disk only ever supports 'push' -- 'sync' is not one of its supportedModes
    const result = mapStorageRow(baseRow({ key: 'disk', mode: 'sync' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'updated')
    assert.ok(!('syncMode' in result.update!.values))
    assert.deepEqual(result.droppedFields, { mode: 'sync' })
  })

  test('a cron shape with no duration equivalent (a pinned time of day) is dropped and reported, not written', async () => {
    const result = mapStorageRow(baseRow({ key: 'git', syncInterval: '30 9 * * 1' }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'updated')
    assert.ok(!('scheduleOverride' in result.update!.values))
    assert.deepEqual(result.droppedFields, { syncInterval: '30 9 * * 1' })
  })

  test('a null/absent mode and syncInterval map to nothing, and are not reported as dropped', async () => {
    const result = mapStorageRow(baseRow({ key: 'disk', mode: null, syncInterval: null }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'updated')
    assert.ok(!('syncMode' in result.update!.values))
    assert.ok(!('scheduleOverride' in result.update!.values))
    assert.equal(result.droppedFields, undefined)
  })
})

describe('mapStorageRow: disk (direct prop copy)', () => {
  test('copies path/createDailyBackups straight across and maps isEnabled directly', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 'disk',
        isEnabled: true,
        config: { path: '/mnt/wiki-data', createDailyBackups: true }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.siteId, SITE_A)
    assert.equal(result.update!.module, 'disk')
    assert.equal(result.update!.values.isEnabled, true)
    assert.equal(result.update!.values.config!.path, '/mnt/wiki-data')
    assert.equal(result.update!.values.config!.createDailyBackups, true)
  })
})

describe('mapStorageRow: git (enum value rename + dropped no-destination prop)', () => {
  test('sshPrivateKeyMode "contents" is rewritten to "inline"', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 'git',
        config: {
          authType: 'ssh',
          repoUrl: 'git@example.com:org/repo.git',
          sshPrivateKeyMode: 'contents',
          sshPrivateKeyContent: 'THEKEY'
        }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.values.config!.sshPrivateKeyMode, 'inline')
    assert.equal(result.update!.values.config!.repoUrl, 'git@example.com:org/repo.git')
  })

  test('alwaysNamespace (confirmed NO DESTINATION) is dropped without failing validation', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 'git',
        config: { authType: 'basic', alwaysNamespace: true, basicUsername: 'bob' }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.ok(!('alwaysNamespace' in result.update!.values.config!))
    assert.equal(result.update!.values.config!.basicUsername, 'bob')
  })
})

describe('mapStorageRow: s3 (region -> awsRegion + synthesized mode)', () => {
  test('a valid AWS region maps to awsRegion and synthesizes mode: aws', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 's3',
        config: {
          region: 'us-east-1',
          bucket: 'my-wiki',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'shh'
        }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.values.config!.mode, 'aws')
    assert.equal(result.update!.values.config!.awsRegion, 'us-east-1')
    assert.equal(result.update!.values.config!.bucket, 'my-wiki')
  })

  test('a region with no matching 3.0 enum entry fails validation and comes back flagged', async () => {
    const result = mapStorageRow(baseRow({ key: 's3', config: { region: 'not-a-real-region' } }), {
      resolver: await resolver(),
      siteId: SITE_A
    })
    assert.equal(result.status, 'flagged')
    assert.equal(result.update, undefined)
    assert.match(result.message!, /failed validation/)
  })
})

describe('mapStorageRow: azure (enum value case remap)', () => {
  test('storageTier "Cool"/"Hot" (2.x casing) is lower-cased to match 3.0\'s enum', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 'azure',
        config: {
          accountName: 'acct',
          accountKey: 'key',
          containerName: 'wiki',
          storageTier: 'Cool'
        }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.values.config!.storageTier, 'cool')
  })
})

describe('mapStorageRow: sftp (direct prop copy)', () => {
  test('copies every prop straight across', async () => {
    const result = mapStorageRow(
      baseRow({
        key: 'sftp',
        config: {
          host: 'sftp.example.com',
          port: 22,
          authMode: 'password',
          username: 'u',
          password: 'p'
        }
      }),
      { resolver: await resolver(), siteId: SITE_A }
    )
    assert.equal(result.status, 'updated')
    assert.equal(result.update!.values.config!.host, 'sftp.example.com')
    assert.equal(result.update!.values.config!.authMode, 'password')
  })
})

describe('mapStorageRows: per-site replay, no cross-call state', () => {
  test('the same source rows replayed against two different siteIds produce independent, non-interfering update sets', async () => {
    const rows: SourceStorageRow[] = [
      baseRow({ key: 'disk', config: { path: '/data' } }),
      baseRow({ key: 'git', config: { authType: 'ssh', repoUrl: 'git@x:y/z.git' } })
    ]
    const res = await resolver()
    const resultA = await mapStorageRows(rows, { resolver: res, siteId: SITE_A })
    const resultB = await mapStorageRows(rows, { resolver: res, siteId: SITE_B })

    const updatesA = resultA.results.filter((r) => r.status === 'updated').map((r) => r.update!)
    const updatesB = resultB.results.filter((r) => r.status === 'updated').map((r) => r.update!)
    assert.equal(updatesA.length, 2)
    assert.equal(updatesB.length, 2)
    assert.ok(updatesA.every((u) => u.siteId === SITE_A))
    assert.ok(updatesB.every((u) => u.siteId === SITE_B))
    // -> Identical config on both sides: nothing about site A's replay affected site B's
    assert.deepEqual(
      updatesA.map((u) => u.values.config),
      updatesB.map((u) => u.values.config)
    )
  })
})
