import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { CustomError } from '../../helpers/common.ts'
import { handleUploadAsset } from './uploadAsset.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const CONTENT_B64 = Buffer.from('hello world').toString('base64')

let wikiHandle: { restore(): void }
let uploadCalls: any[]
let checkAccessCalls: any[]
let auditCalls: any[]
let getFolderByIdCalls: any[]
let getFolderCalls: any[]
let folders: Record<string, { id: string; siteId: string; folderPath: string; fileName: string }>

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  access = [] as string[]
} = {}) {
  uploadCalls = []
  checkAccessCalls = []
  auditCalls = []
  getFolderByIdCalls = []
  getFolderCalls = []
  folders = {
    'folder-1': { id: 'folder-1', siteId: SITE_ID, folderPath: '', fileName: 'images' }
  }
  wikiHandle = installTestWiki({
    config: { security: { uploadMaxFileSize: 10485760 } },
    sites: {
      [SITE_ID]: {
        id: SITE_ID,
        hostname: 'a.example.com',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      }
    },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string, page: any) => {
          checkAccessCalls.push(page)
          return access.includes(permission)
        }
      },
      tree: {
        getFolderById: async (id: string, siteId: string) => {
          getFolderByIdCalls.push({ id, siteId })
          const folder = folders[id]
          return folder && folder.siteId === siteId ? folder : null
        },
        getFolder: async ({ path, locale, siteId, createIfMissing }: any) => {
          getFolderCalls.push({ path, locale, siteId, createIfMissing })
          return { id: 'created-folder-1', siteId, folderPath: '', fileName: path }
        }
      },
      assets: {
        upload: async (input: any) => {
          uploadCalls.push(input)
          return {
            id: 'asset-1',
            fileName: input.fileName,
            fileExt: 'txt',
            kind: 'document',
            mimeType: input.mimeType ?? 'application/octet-stream',
            fileSize: input.data.length,
            folderPath: '',
            title: input.fileName,
            hasPreview: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            locale: input.locale
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
    userId,
    scope: null as string[] | null
  }
}

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleUploadAsset: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null, access: ['write:assets'] })
  await assert.rejects(
    () => handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID }),
    /personal access token/
  )
  assert.equal(uploadCalls.length, 0)
})

test('handleUploadAsset: refuses without write:assets on the destination', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(
    () => handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID }),
    /not allowed/
  )
  assert.equal(uploadCalls.length, 0)
})

test('handleUploadAsset: refuses empty file content', async () => {
  const c = ctx({ access: ['write:assets'] })
  await assert.rejects(
    () => handleUploadAsset(c, { fileName: 'a.txt', content: '', siteId: SITE_ID }),
    /No file content/
  )
  assert.equal(uploadCalls.length, 0)
})

test('handleUploadAsset: uploads to the site root when no folder is named', async () => {
  const c = ctx({ access: ['write:assets'] })
  const result = await handleUploadAsset(c, {
    fileName: 'a.txt',
    content: CONTENT_B64,
    siteId: SITE_ID
  })
  assert.equal(uploadCalls.length, 1)
  assert.equal(uploadCalls[0].siteId, SITE_ID)
  assert.equal(uploadCalls[0].fileName, 'a.txt')
  assert.equal(uploadCalls[0].folderId, undefined)
  assert.equal(uploadCalls[0].authorId, 'user-1')
  assert.deepEqual(uploadCalls[0].data, Buffer.from('hello world'))
  assert.equal(checkAccessCalls[0].path, 'a.txt')
  const asset = textOf(result)
  assert.equal(asset.id, 'asset-1')
  assert.equal(asset.fileName, 'a.txt')
})

test('handleUploadAsset: resolves a destination folder by folderId', async () => {
  const c = ctx({ access: ['write:assets'] })
  await handleUploadAsset(c, {
    fileName: 'a.txt',
    content: CONTENT_B64,
    siteId: SITE_ID,
    folderId: 'folder-1'
  })
  assert.equal(getFolderByIdCalls.length, 1)
  assert.equal(getFolderByIdCalls[0].id, 'folder-1')
  assert.equal(checkAccessCalls[0].path, 'images/a.txt')
  assert.equal(uploadCalls[0].folderId, 'folder-1')
})

test('handleUploadAsset: refuses an unknown or cross-site folderId', async () => {
  const c = ctx({ access: ['write:assets'] })
  await assert.rejects(
    () =>
      handleUploadAsset(c, {
        fileName: 'a.txt',
        content: CONTENT_B64,
        siteId: SITE_ID,
        folderId: 'nope'
      }),
    /does not exist/
  )
  assert.equal(uploadCalls.length, 0)
})

test('handleUploadAsset: parentPath resolves (and creates, if missing) the destination folder', async () => {
  const c = ctx({ access: ['write:assets'] })
  await handleUploadAsset(c, {
    fileName: 'a.txt',
    content: CONTENT_B64,
    siteId: SITE_ID,
    parentPath: 'docs/guides'
  })
  assert.equal(checkAccessCalls[0].path, 'docs/guides/a.txt')
  assert.equal(getFolderCalls.length, 1)
  assert.equal(getFolderCalls[0].path, 'docs/guides')
  assert.equal(getFolderCalls[0].createIfMissing, true)
  assert.equal(uploadCalls[0].folderId, 'created-folder-1')
})

test('handleUploadAsset: folderId wins over parentPath', async () => {
  const c = ctx({ access: ['write:assets'] })
  await handleUploadAsset(c, {
    fileName: 'a.txt',
    content: CONTENT_B64,
    siteId: SITE_ID,
    folderId: 'folder-1',
    parentPath: 'docs/guides'
  })
  assert.equal(getFolderCalls.length, 0)
  assert.equal(uploadCalls[0].folderId, 'folder-1')
})

test('handleUploadAsset: an omitted locale resolves to the site default', async () => {
  const c = ctx({ access: ['write:assets'] })
  await handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID })
  assert.equal(checkAccessCalls[0].locale, 'en')
  assert.equal(uploadCalls[0].locale, 'en')
})

test('handleUploadAsset: records an mcp.writeToolCalled audit log entry naming the new asset', async () => {
  const c = ctx({ access: ['write:assets'] })
  await handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID })
  assert.equal(auditCalls.length, 1)
  assert.equal(auditCalls[0].event, 'mcp.writeToolCalled')
  assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-1' })
  assert.equal(auditCalls[0].targetType, 'asset')
  assert.equal(auditCalls[0].targetId, 'asset-1')
  assert.equal(auditCalls[0].targetLabel, 'a.txt')
  assert.deepEqual(auditCalls[0].detail, { tool: 'upload_asset' })
  assert.equal(auditCalls[0].siteId, SITE_ID)
})

test('handleUploadAsset: refused calls never reach the audit log', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() =>
    handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID })
  )
  assert.equal(auditCalls.length, 0)
})

test('handleUploadAsset: wraps a model validation failure as an McpToolError', async () => {
  const c = ctx({ access: ['write:assets'] })
  ;(globalThis as any).WIKI.models.assets.upload = async () => {
    throw new CustomError('assetInvalidFileName', 'This file name cannot be used.')
  }
  await assert.rejects(
    () => handleUploadAsset(c, { fileName: '???', content: CONTENT_B64, siteId: SITE_ID }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /cannot be used/)
      return true
    }
  )
})

test('handleUploadAsset: refuses content over the configured upload size limit', async () => {
  const c = ctx({ access: ['write:assets'] })
  ;(globalThis as any).WIKI.config.security.uploadMaxFileSize = 4
  await assert.rejects(
    () => handleUploadAsset(c, { fileName: 'a.txt', content: CONTENT_B64, siteId: SITE_ID }),
    /exceeds the/
  )
  assert.equal(uploadCalls.length, 0)
})
