import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { handleListAssets } from './listAssets.ts'
import { installTestWiki } from '../../test/mocks.ts'

const GUEST_GROUP_ID = '10000000-0000-4000-8000-000000000001'
const SITE_ID = 'site-a'
const CTX = {
  keyId: 'key-1',
  permissions: [] as string[],
  siteId: null as string | null,
  groupIds: [GUEST_GROUP_ID],
  userId: null as string | null,
  scope: null as string[] | null
}

const ITEMS = [
  {
    id: 'asset-allowed',
    type: 'asset',
    depth: 1,
    folderPath: 'docs',
    fileName: 'allowed.png',
    title: 'allowed.png',
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    fileSize: 1234,
    fileExt: 'png',
    mimeType: 'image/png'
  },
  {
    id: 'asset-hidden',
    type: 'asset',
    depth: 1,
    folderPath: 'docs',
    fileName: 'hidden.pdf',
    title: 'hidden.pdf',
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    fileSize: 5678,
    fileExt: 'pdf',
    mimeType: 'application/pdf'
  }
]

let wikiHandle: { restore(): void }
let getTreeCalls: any[]
let checkAccessCalls: any[]

function install({ items = ITEMS as typeof ITEMS, readablePaths = [] as string[] } = {}) {
  getTreeCalls = []
  checkAccessCalls = []
  wikiHandle = installTestWiki({
    data: { systemIds: { guestsGroupId: GUEST_GROUP_ID } },
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
        checkAccess: (_actor: any, permission: string, page: { path: string }) => {
          checkAccessCalls.push({ permission, path: page.path })
          return readablePaths.includes(page.path)
        }
      },
      tree: {
        getTree: async (params: any) => {
          getTreeCalls.push(params)
          return items
        }
      }
    }
  })
}

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListAssets: lists only assets, scoped to this site and locale', async () => {
  install({ readablePaths: ['docs/allowed.png', 'docs/hidden.pdf'] })
  await handleListAssets(CTX, { siteId: SITE_ID })
  assert.equal(getTreeCalls[0].siteId, SITE_ID)
  assert.deepEqual(getTreeCalls[0].types, ['asset'])
  assert.equal(getTreeCalls[0].locale, 'en')
})

test('handleListAssets: defaults locale to the site primary locale', async () => {
  install({ readablePaths: [] })
  await handleListAssets(CTX, { siteId: SITE_ID })
  assert.equal(getTreeCalls[0].locale, 'en')
})

test('handleListAssets: an explicit locale overrides the site default', async () => {
  install({ readablePaths: [] })
  await handleListAssets(CTX, { siteId: SITE_ID, locale: 'fr' })
  assert.equal(getTreeCalls[0].locale, 'fr')
})

test('handleListAssets: passes the folder path through as parentPath', async () => {
  install({ readablePaths: [] })
  await handleListAssets(CTX, { siteId: SITE_ID, path: 'docs' })
  assert.equal(getTreeCalls[0].parentPath, 'docs')
})

test('handleListAssets: filters items down to what read:assets grants, item by item', async () => {
  install({ readablePaths: ['docs/allowed.png'] })
  const result = await handleListAssets(CTX, { siteId: SITE_ID })
  const assets = textOf(result)
  assert.deepEqual(
    assets.map((a: any) => a.fileName),
    ['allowed.png']
  )
})

test('handleListAssets: checks read:assets, not read:pages, with no classification', async () => {
  install({ readablePaths: ['docs/allowed.png', 'docs/hidden.pdf'] })
  await handleListAssets(CTX, { siteId: SITE_ID })
  assert.ok(checkAccessCalls.every((c) => c.permission === 'read:assets'))
})

test('handleListAssets: an empty folder (or an unknown one) answers an empty list, not an error', async () => {
  install({ items: [], readablePaths: [] })
  const result = await handleListAssets(CTX, { siteId: SITE_ID, path: 'nope' })
  assert.deepEqual(textOf(result), [])
})

test('handleListAssets: returns the asset fields a caller needs to fetch or reference the file', async () => {
  install({ readablePaths: ['docs/allowed.png'] })
  const result = await handleListAssets(CTX, { siteId: SITE_ID })
  const [asset] = textOf(result)
  assert.equal(asset.id, 'asset-allowed')
  assert.equal(asset.fileName, 'allowed.png')
  assert.equal(asset.folderPath, 'docs')
  assert.equal(asset.fileExt, 'png')
  assert.equal(asset.mimeType, 'image/png')
  assert.equal(asset.fileSize, 1234)
})
