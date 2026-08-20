import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleListNavigation } from './listNavigation.ts'

const GUEST_GROUP_ID = '10000000-0000-4000-8000-000000000001'
const SITE_ID = 'site-a'
const CTX = { keyId: 'key-1', permissions: [] as string[], siteId: null as string | null }

const LEVEL = {
  path: 'docs',
  title: 'Docs',
  truncated: false,
  items: [
    {
      path: 'docs/allowed',
      fileName: 'allowed',
      title: 'Allowed',
      icon: null,
      isPage: true,
      isFolder: false
    },
    {
      path: 'docs/hidden',
      fileName: 'hidden',
      title: 'Hidden',
      icon: null,
      isPage: true,
      isFolder: false
    }
  ]
}

let previousWiki: any
let browseCalls: any[]

function install({
  browseEnabled = true,
  level = LEVEL as typeof LEVEL | null,
  readablePaths = [] as string[]
} = {}) {
  browseCalls = []
  ;(globalThis as any).WIKI = {
    data: { systemIds: { guestsGroupId: GUEST_GROUP_ID } },
    sites: {
      [SITE_ID]: {
        id: SITE_ID,
        hostname: 'a.example.com',
        isEnabled: true,
        config: { features: { browse: browseEnabled }, locales: { primary: 'en' } }
      }
    },
    models: {
      groups: {
        checkAccess: (_actor: any, _permission: string, page: { path: string }) =>
          readablePaths.includes(page.path)
      },
      tree: {
        browse: async (params: any) => {
          browseCalls.push(params)
          return level
        }
      }
    }
  }
}

before(() => {
  previousWiki = (globalThis as any).WIKI
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListNavigation: refuses when the site has browsing disabled', async () => {
  install({ browseEnabled: false })
  await assert.rejects(
    () => handleListNavigation(CTX, { siteId: SITE_ID }),
    /[Bb]rowsing is disabled/
  )
})

test('handleListNavigation: refuses when the folder does not exist', async () => {
  install({ level: null })
  await assert.rejects(
    () => handleListNavigation(CTX, { siteId: SITE_ID, path: 'nope' }),
    McpToolError
  )
})

test('handleListNavigation: defaults locale to the site primary locale', async () => {
  install({ readablePaths: ['docs/allowed', 'docs/hidden'] })
  await handleListNavigation(CTX, { siteId: SITE_ID })
  assert.equal(browseCalls[0].locale, 'en')
  assert.equal(browseCalls[0].publicOnly, false)
})

test('handleListNavigation: filters items down to what read:pages grants, item by item', async () => {
  install({ readablePaths: ['docs/allowed'] })
  const result = await handleListNavigation(CTX, { siteId: SITE_ID })
  const level = textOf(result)
  assert.deepEqual(
    level.items.map((i: any) => i.path),
    ['docs/allowed']
  )
})

test('handleListNavigation: an explicit locale overrides the site default', async () => {
  install({ readablePaths: [] })
  await handleListNavigation(CTX, { siteId: SITE_ID, locale: 'fr' })
  assert.equal(browseCalls[0].locale, 'fr')
})
