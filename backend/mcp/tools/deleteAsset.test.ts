import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleDeleteAsset } from './deleteAsset.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const ASSET_ID = 'asset-1'

let wikiHandle: { restore(): void }
let deleteCalls: any[]
let auditCalls: any[]
let checkAccessCalls: any[]

function ctx({
  permissions = [] as string[],
  access = [] as string[],
  assetExists = true,
  deleteSucceeds = true,
  folderPath = 'docs' as string | null
} = {}) {
  deleteCalls = []
  auditCalls = []
  checkAccessCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        checkAccess: (actor: any, permission: string, ref: any) => {
          checkAccessCalls.push({ actor, permission, ref })
          return access.includes(permission)
        }
      },
      assets: {
        getAsset: async (_siteId: string, id: string) => {
          if (!assetExists) {
            return null
          }
          return {
            id,
            fileName: 'photo.png',
            folderPath,
            locale: 'en'
          }
        },
        deleteAsset: async (siteId: string, id: string) => {
          deleteCalls.push({ siteId, id })
          return deleteSucceeds
        }
      },
      auditLog: {
        record: async (entry: any) => {
          auditCalls.push(entry)
        }
      }
    }
  })
  return {
    keyId: 'key-1',
    permissions,
    siteId: null as string | null,
    groupIds: [GROUP_ID],
    userId: null as string | null,
    scope: null as string[] | null
  }
}

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleDeleteAsset: throws when the asset does not exist', async () => {
  const c = ctx({ assetExists: false, access: ['manage:assets'] })
  await assert.rejects(
    () => handleDeleteAsset(c, { assetId: ASSET_ID }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /does not exist/)
      return true
    }
  )
  assert.equal(deleteCalls.length, 0)
})

test('handleDeleteAsset: refuses without manage:assets on the asset', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(
    () => handleDeleteAsset(c, { assetId: ASSET_ID }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /not allowed/)
      return true
    }
  )
  assert.equal(deleteCalls.length, 0)
})

test("handleDeleteAsset: checks manage:assets against the asset's own folder/file path", async () => {
  const c = ctx({ access: ['manage:assets'], folderPath: 'docs/images' })
  await handleDeleteAsset(c, { assetId: ASSET_ID })
  assert.equal(checkAccessCalls.length, 1)
  assert.equal(checkAccessCalls[0].permission, 'manage:assets')
  assert.deepEqual(checkAccessCalls[0].ref, {
    path: 'docs/images/photo.png',
    siteId: SITE_ID,
    locale: 'en',
    classification: null
  })
})

test('handleDeleteAsset: builds a bare-filename path for a site-root asset', async () => {
  const c = ctx({ access: ['manage:assets'], folderPath: '' })
  await handleDeleteAsset(c, { assetId: ASSET_ID })
  assert.equal(checkAccessCalls[0].ref.path, 'photo.png')
})

test('handleDeleteAsset: deletes the asset and returns its identity', async () => {
  const c = ctx({ access: ['manage:assets'] })
  const result = await handleDeleteAsset(c, { assetId: ASSET_ID })
  assert.equal(deleteCalls.length, 1)
  assert.equal(deleteCalls[0].siteId, SITE_ID)
  assert.equal(deleteCalls[0].id, ASSET_ID)
  const payload = textOf(result)
  assert.equal(payload.ok, true)
  assert.equal(payload.id, ASSET_ID)
  assert.equal(payload.fileName, 'photo.png')
})

test('handleDeleteAsset: throws not-found when the asset vanishes between lookup and delete', async () => {
  const c = ctx({ access: ['manage:assets'], deleteSucceeds: false })
  await assert.rejects(
    () => handleDeleteAsset(c, { assetId: ASSET_ID }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /does not exist/)
      return true
    }
  )
  assert.equal(auditCalls.length, 0)
})

test('handleDeleteAsset: records an mcp.writeToolCalled audit log entry naming the asset', async () => {
  const c = ctx({ access: ['manage:assets'], folderPath: 'docs' })
  await handleDeleteAsset(c, { assetId: ASSET_ID })
  assert.equal(auditCalls.length, 1)
  assert.equal(auditCalls[0].event, 'mcp.writeToolCalled')
  assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-1' })
  assert.equal(auditCalls[0].targetType, 'asset')
  assert.equal(auditCalls[0].targetId, ASSET_ID)
  assert.equal(auditCalls[0].targetLabel, 'docs/photo.png')
  assert.deepEqual(auditCalls[0].detail, { tool: 'delete_asset' })
  assert.equal(auditCalls[0].siteId, SITE_ID)
})

test('handleDeleteAsset: refused calls never reach the audit log', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() => handleDeleteAsset(c, { assetId: ASSET_ID }))
  assert.equal(auditCalls.length, 0)
})
