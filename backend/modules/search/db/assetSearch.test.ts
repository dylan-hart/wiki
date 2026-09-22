import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../../test/db.ts'
import { assets as assetsTable, groups as groupsTable } from '../../../db/schema.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import type { AccessActor, GroupRule } from '../../../models/groups.ts'

describe('searchAssets (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let assetsModel: typeof import('../../../models/assets.ts').assets
  let searchAssets: typeof import('./assetSearch.ts').searchAssets
  let openId: string
  let secretId: string

  async function seedAsset(folderPath: string, fileName: string): Promise<string> {
    const entry = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      type: 'asset',
      folderPath,
      fileName
    })
    await fixtures.db.insert(assetsTable).values({
      id: entry.id,
      fileName,
      fileExt: 'pdf',
      authorId: fixtures.userId,
      siteId: fixtures.siteId
    })
    return entry.id
  }

  function readRule(path: string): GroupRule {
    return {
      id: randomUUID(),
      name: `read ${path}`,
      roles: ['read:assets'],
      match: 'START',
      mode: 'ALLOW',
      path,
      locales: [],
      sites: []
    }
  }

  before(async () => {
    fixtures = await setupTestDb()
    ;({ assets: assetsModel } = await import('../../../models/assets.ts'))
    ;({ searchAssets } = await import('./assetSearch.ts'))

    openId = await seedAsset('docs', 'manual.pdf')
    secretId = await seedAsset('secret', 'plan.pdf')
    await assetsModel.setSearchContent(openId, 'The wandering kangaroo crossed the outback')
    await assetsModel.setSearchContent(secretId, 'A kangaroo escape plan, for staff only')
  })

  after(async () => {
    await teardownTestDb()
  })

  async function actorWith(rules: GroupRule[]): Promise<AccessActor> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await CARDINAL.models.groups.reloadCache()
    return { groupIds: [fixtures.groupId], permissions: [] }
  }

  test('finds an asset by its extracted text, with an excerpt', async () => {
    const admin: AccessActor = { groupIds: [], permissions: ['manage:system'] }

    const result = await searchAssets({ siteId: fixtures.siteId, query: 'outback', actor: admin })

    assert.equal(result.totalHits, 1)
    assert.equal(result.results[0]!.id, openId)
    assert.equal(result.results[0]!.folderPath, 'docs')
    assert.equal(result.results[0]!.fileName, 'manual.pdf')
    assert.match(result.results[0]!.highlight!, /<b>outback<\/b>/)
  })

  test('a caller without read:assets finds nothing, and no count leaks', async () => {
    const nobody = await actorWith([])

    const result = await searchAssets({ siteId: fixtures.siteId, query: 'kangaroo', actor: nobody })

    assert.deepEqual(result, { results: [], totalHits: 0, totalHitsApproximate: false })
  })

  test('a caller is shown only the assets whose path their rules allow', async () => {
    const reader = await actorWith([readRule('docs')])

    const result = await searchAssets({ siteId: fixtures.siteId, query: 'kangaroo', actor: reader })

    assert.deepEqual(
      result.results.map((r) => r.id),
      [openId]
    )
    assert.equal(result.totalHits, 1)
    assert.equal(result.totalHitsApproximate, true)
  })

  test('a caller holding a page permission but not read:assets finds nothing', async () => {
    const pageReader = await actorWith([{ ...readRule(''), roles: ['read:pages'] }])

    const result = await searchAssets({
      siteId: fixtures.siteId,
      query: 'kangaroo',
      actor: pageReader
    })

    assert.equal(result.totalHits, 0)
  })

  test('clearing the text removes the asset from the results', async () => {
    const admin: AccessActor = { groupIds: [], permissions: ['manage:system'] }
    await assetsModel.setSearchContent(secretId, null)

    const result = await searchAssets({ siteId: fixtures.siteId, query: 'kangaroo', actor: admin })

    assert.deepEqual(
      result.results.map((r) => r.id),
      [openId]
    )
  })

  test('a blank query matches nothing', async () => {
    const admin: AccessActor = { groupIds: [], permissions: ['manage:system'] }

    const result = await searchAssets({ siteId: fixtures.siteId, query: '   ', actor: admin })

    assert.equal(result.totalHits, 0)
  })
})

describe('searchAssets visibility (stubbed db)', () => {
  const actor: AccessActor = { groupIds: [], permissions: [] }
  const row = (folderPath: string, fileName: string) => ({
    id: fileName,
    fileName,
    fileExt: 'pdf',
    kind: 'document',
    mimeType: 'application/pdf',
    fileSize: 10,
    folderPath,
    title: fileName,
    locale: 'en',
    hasPreview: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    relevancy: 0.5,
    highlight: null
  })
  let wikiHandle: { restore(): void }
  let execute: ReturnType<typeof mock.fn>
  let holdsAnywhere = true
  const checked: any[] = []

  before(() => {
    execute = mock.fn(async () => ({ rows: [row('docs', 'a.pdf'), row('secret', 'b.pdf')] }))
    wikiHandle = installTestWiki({
      db: { execute },
      models: {
        groups: {
          mayHoldPermissionSomewhere: () => holdsAnywhere,
          checkAccess: (_actor: any, permission: string, ref: any) => {
            checked.push({ permission, ref })
            return ref.path.startsWith('docs/')
          }
        }
      }
    })
  })

  after(() => wikiHandle.restore())

  test('drops a row read:assets does not cover, judged on its path and locale, and flags the total approximate', async () => {
    const { searchAssets } = await import('./assetSearch.ts')

    const result = await searchAssets({ siteId: 'site-1', query: 'kangaroo', actor })

    assert.deepEqual(
      result.results.map((r) => r.id),
      ['a.pdf']
    )
    assert.equal(result.totalHits, 1)
    assert.equal(result.totalHitsApproximate, true)
    assert.deepEqual(checked[0], {
      permission: 'read:assets',
      ref: { path: 'docs/a.pdf', siteId: 'site-1', locale: 'en', classification: null }
    })
  })

  test('a caller who holds read:assets nowhere never reaches the database', async () => {
    holdsAnywhere = false
    execute.mock.resetCalls()
    const { searchAssets } = await import('./assetSearch.ts')

    const result = await searchAssets({ siteId: 'site-1', query: 'kangaroo', actor })

    assert.deepEqual(result, { results: [], totalHits: 0, totalHitsApproximate: false })
    assert.equal(execute.mock.callCount(), 0)
  })
})
