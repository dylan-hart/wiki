import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleSideloadLocales } from './sideloadLocales.ts'
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

function install(sideloadFromDataPath: (opts: { force?: boolean }) => Promise<any>) {
  const calls: any[] = []
  wikiHandle = installTestWiki({
    models: {
      locales: {
        sideloadFromDataPath: async (opts: { force?: boolean }) => {
          calls.push(opts)
          return sideloadFromDataPath(opts)
        }
      }
    }
  })
  return calls
}

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleSideloadLocales: refuses a caller without manage:system', async () => {
  install(async () => ({ loaded: [], skipped: [] }))
  await assert.rejects(
    () => handleSideloadLocales(CTX),
    (err: any) => {
      assert.ok(err instanceof McpToolError)
      assert.equal(err.message, 'You are not allowed to sideload locales.')
      return true
    }
  )
})

test('handleSideloadLocales: force-reloads via the model, exactly like the REST route', async () => {
  const calls = install(async () => ({ loaded: ['fr'], skipped: [] }))
  const result = await handleSideloadLocales({ ...CTX, permissions: ['manage:system'] })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { force: true })
  assert.deepEqual(textOf(result), { loaded: ['fr'], skipped: [] })
})

test('handleSideloadLocales: returns the model result as-is, skipped entries included', async () => {
  install(async () => ({
    loaded: [],
    skipped: [{ code: 'xx', error: 'invalid JSON' }]
  }))
  const result = await handleSideloadLocales({ ...CTX, permissions: ['manage:system'] })
  assert.deepEqual(textOf(result), {
    loaded: [],
    skipped: [{ code: 'xx', error: 'invalid JSON' }]
  })
})
