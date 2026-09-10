import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleSideloadIcons } from './sideloadIcons.ts'
import { installTestWiki } from '../../test/mocks.ts'

const CTX = {
  keyId: 'key-1',
  permissions: [] as string[],
  siteId: null as string | null,
  groupIds: [] as string[],
  userId: 'user-1' as string | null,
  scope: null as string[] | null
}

let wikiHandle: { restore(): void }

after(() => {
  wikiHandle.restore()
})

function install(sideloadFromDataPath: () => Promise<any>) {
  const calls: any[] = []
  wikiHandle = installTestWiki({
    models: {
      icons: {
        sideloadFromDataPath: async () => {
          calls.push(true)
          return sideloadFromDataPath()
        }
      }
    }
  })
  return calls
}

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleSideloadIcons: refuses a caller without manage:system', async () => {
  install(async () => ({ loaded: [], skipped: [] }))
  await assert.rejects(
    () => handleSideloadIcons(CTX),
    (err: any) => {
      assert.ok(err instanceof McpToolError)
      assert.equal(err.message, 'You are not allowed to sideload icon sets.')
      return true
    }
  )
})

test('handleSideloadIcons: reloads via the model with no arguments', async () => {
  const calls = install(async () => ({
    loaded: [{ prefix: 'tabler', iconCount: 42 }],
    skipped: []
  }))
  const result = await handleSideloadIcons({ ...CTX, permissions: ['manage:system'] })
  assert.equal(calls.length, 1)
  assert.deepEqual(textOf(result), { loaded: [{ prefix: 'tabler', iconCount: 42 }], skipped: [] })
})

test('handleSideloadIcons: returns the model result as-is, skipped entries included', async () => {
  install(async () => ({
    loaded: [],
    skipped: [{ prefix: 'bogus', error: 'no usable icons found in file' }]
  }))
  const result = await handleSideloadIcons({ ...CTX, permissions: ['manage:system'] })
  assert.deepEqual(textOf(result), {
    loaded: [],
    skipped: [{ prefix: 'bogus', error: 'no usable icons found in file' }]
  })
})
