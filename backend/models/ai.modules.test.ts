import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../helpers/moduleProps.ts'
import { installTestWiki } from '../test/mocks.ts'
import type { AiProviderGenerate } from './ai.ts'

const AI_MODULES_DIR = path.join(import.meta.dirname, '..', 'modules', 'ai')
const SECRET = 'sk-shape-test-secret'
const PROMPT = 'shape test prompt body'

const moduleKeys = existsSync(AI_MODULES_DIR)
  ? readdirSync(AI_MODULES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : []

function readDefinition(key: string): Record<string, any> {
  return load(readFileSync(path.join(AI_MODULES_DIR, key, 'definition.yml'), 'utf8')) as Record<
    string,
    any
  >
}

async function importGenerate(key: string): Promise<AiProviderGenerate> {
  return (await import(`../modules/ai/${key}/ai.ts`)).default
}

for (const key of moduleKeys) {
  describe(`modules/ai/${key}`, () => {
    let wikiHandle: { restore(): void }
    let logged: unknown[][]
    const realFetch = globalThis.fetch

    beforeEach(() => {
      logged = []
      wikiHandle = installTestWiki({ config: {} })
      const record = (...args: unknown[]) => {
        logged.push(args)
      }
      CARDINAL.logger.error = record
      CARDINAL.logger.warn = record
      CARDINAL.logger.info = record
      CARDINAL.logger.debug = record
    })

    afterEach(() => {
      globalThis.fetch = realFetch
      wikiHandle.restore()
    })

    function assertNothingLeaked() {
      const serialized = JSON.stringify(logged, (_k, v) =>
        v instanceof Error ? { name: v.name, message: v.message } : v
      )
      assert.ok(!serialized.includes(SECRET), 'a log line must never carry the API key')
      assert.ok(!serialized.includes(PROMPT), 'a log line must never carry the prompt')
    }

    test('definition.yml declares its own key, a title and a sensitive, required apiKey', () => {
      const definition = readDefinition(key)
      assert.equal(definition.key, key)
      assert.equal(typeof definition.title, 'string')
      const props = parseModuleProps(definition.props ?? {})
      assert.ok(props.apiKey, 'an AI provider declares an apiKey prop')
      assert.equal(props.apiKey.sensitive, true)
      assert.equal(props.apiKey.required, true)
    })

    test('definition.yml declares a model prop', () => {
      const props = parseModuleProps(readDefinition(key).props ?? {})
      assert.ok(props.model, 'an AI provider declares a model prop')
    })

    test('ai.ts default-exports a generate function', async () => {
      assert.equal(typeof (await importGenerate(key)), 'function')
    })

    test('returns null in offline mode without touching the network', async () => {
      CARDINAL.config.offline = true
      let fetched = false
      globalThis.fetch = (async () => {
        fetched = true
        throw new Error('network reached in offline mode')
      }) as typeof fetch
      const generate = await importGenerate(key)
      const result = await generate(PROMPT, { siteId: 'site-1' }, { apiKey: SECRET, model: 'm' })
      assert.equal(result, null)
      assert.equal(fetched, false)
      assertNothingLeaked()
    })

    test('returns null, never throwing, when the provider rejects the key', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch
      const generate = await importGenerate(key)
      const result = await generate(PROMPT, { siteId: 'site-1' }, { apiKey: SECRET, model: 'm' })
      assert.equal(result, null)
      assertNothingLeaked()
    })

    test('returns null, never throwing, when the request itself fails', async () => {
      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch
      const generate = await importGenerate(key)
      const result = await generate(PROMPT, { siteId: 'site-1' }, { apiKey: SECRET, model: 'm' })
      assert.equal(result, null)
      assertNothingLeaked()
    })
  })
}

test('every modules/ai directory holds a definition.yml', () => {
  assert.deepEqual(
    moduleKeys.filter((key) => !existsSync(path.join(AI_MODULES_DIR, key, 'definition.yml'))),
    []
  )
})
