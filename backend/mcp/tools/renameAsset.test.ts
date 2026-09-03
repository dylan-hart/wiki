import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { CustomError } from '../../helpers/common.ts'
import { handleRenameAsset } from './renameAsset.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const ASSET_ID = 'asset-1'

let wikiHandle: { restore(): void }
let renameCalls: any[]
let auditCalls: any[]

function ctx({
  permissions = [] as string[],
  access = [] as string[],
  assetExists = true,
  renameThrows = null as Error | null
} = {}) {
  renameCalls = []
  auditCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string) => access.includes(permission)
      },
      assets: {
        getAsset: async (_siteId: string, id: string) => {
          if (!assetExists) {
            return null
          }
          return {
            id,
            fileName: 'old-name.png',
            fileExt: 'png',
            kind: 'image',
            mimeType: 'image/png',
            fileSize: 1234,
            folderPath: 'photos',
            title: 'old-name.png',
            hasPreview: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            locale: 'en'
          }
        },
        renameAsset: async (siteId: string, id: string, fileName: string) => {
          renameCalls.push({ siteId, id, fileName })
          if (renameThrows) {
            throw renameThrows
          }
          return {
            id,
            fileName,
            fileExt: fileName.split('.').pop(),
            kind: 'image',
            mimeType: 'image/png',
            fileSize: 1234,
            folderPath: 'photos',
            title: fileName,
            hasPreview: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-02T00:00:00Z'),
            locale: 'en'
          }
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

test('handleRenameAsset: throws when the asset does not exist', async () => {
  const c = ctx({ assetExists: false, access: ['manage:assets'] })
  await assert.rejects(
    () => handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' }),
    McpToolError
  )
  assert.equal(renameCalls.length, 0)
})

test('handleRenameAsset: refuses without manage:assets on the folder the asset sits in', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(
    () => handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' }),
    /not allowed/
  )
  assert.equal(renameCalls.length, 0)
})

test('handleRenameAsset: works with no userId (admin-issued key, no author to attribute)', async () => {
  const c = ctx({ access: ['manage:assets'] })
  const result = await handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' })
  assert.equal(renameCalls.length, 1)
  assert.equal(renameCalls[0].siteId, SITE_ID)
  assert.equal(renameCalls[0].id, ASSET_ID)
  assert.equal(renameCalls[0].fileName, 'new-name.png')
  const asset = textOf(result)
  assert.equal(asset.fileName, 'new-name.png')
  assert.equal(asset.folderPath, 'photos')
})

test('handleRenameAsset: records an mcp.writeToolCalled audit log entry naming the asset', async () => {
  const c = ctx({ access: ['manage:assets'] })
  await handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' })
  assert.equal(auditCalls.length, 1)
  assert.equal(auditCalls[0].event, 'mcp.writeToolCalled')
  assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-1' })
  assert.equal(auditCalls[0].targetType, 'asset')
  assert.equal(auditCalls[0].targetId, ASSET_ID)
  assert.equal(auditCalls[0].targetLabel, 'photos/new-name.png')
  assert.deepEqual(auditCalls[0].detail, { tool: 'rename_asset' })
  assert.equal(auditCalls[0].siteId, SITE_ID)
})

test('handleRenameAsset: refused calls never reach the audit log', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() => handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' }))
  assert.equal(auditCalls.length, 0)
})

test('handleRenameAsset: throws when the rename itself reports the asset gone', async () => {
  const c = ctx({ access: ['manage:assets'] })
  ;(globalThis as any).WIKI.models.assets.renameAsset = async () => null
  await assert.rejects(
    () => handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'new-name.png' }),
    McpToolError
  )
})

test('handleRenameAsset: wraps a model validation failure (bad name) as an McpToolError', async () => {
  const c = ctx({
    access: ['manage:assets'],
    renameThrows: new CustomError('assetInvalidFileName', 'This file name cannot be used.')
  })
  await assert.rejects(
    () => handleRenameAsset(c, { assetId: ASSET_ID, fileName: 'nope' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /cannot be used/)
      return true
    }
  )
})
