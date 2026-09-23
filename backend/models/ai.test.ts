import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { installTestWiki } from '../test/mocks.ts'
import { SENSITIVE_CONFIG_MASK } from '../helpers/moduleProps.ts'
import { ai } from './ai.ts'
import type { AiProviderContext } from './ai.ts'

const SITE_ID = 'site-1'
const SECRET = 'sk-test-super-secret'
const PROMPT = 'confidential prompt body'

const FAKE_DEFINITION = `key: fake
title: Fake AI
description: A test provider.
vendor: Test
website: https://example.test
props:
  apiKey:
    type: String
    title: API Key
    sensitive: true
    required: true
    order: 1
  model:
    type: String
    title: Model
    default: fake-model-1
    order: 2
`

const NOCODE_DEFINITION = `key: nocode
title: No Code AI
description: A definition with no implementation.
vendor: Test
website: https://example.test
props:
  apiKey:
    type: String
    sensitive: true
    required: true
`

let serverPath: string
let emptyServerPath: string

before(async () => {
  serverPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-ai-'))
  await fs.mkdir(path.join(serverPath, 'modules/ai/fake'), { recursive: true })
  await fs.mkdir(path.join(serverPath, 'modules/ai/nocode'), { recursive: true })
  await fs.writeFile(path.join(serverPath, 'modules/ai/fake/definition.yml'), FAKE_DEFINITION)
  await fs.writeFile(path.join(serverPath, 'modules/ai/fake/ai.ts'), 'export default null\n')
  await fs.writeFile(path.join(serverPath, 'modules/ai/nocode/definition.yml'), NOCODE_DEFINITION)
  emptyServerPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-ai-empty-'))
})

after(async () => {
  await fs.rm(serverPath, { recursive: true, force: true })
  await fs.rm(emptyServerPath, { recursive: true, force: true })
})

function siteWith(aiConfig: Record<string, any> | undefined) {
  return {
    [SITE_ID]: {
      id: SITE_ID,
      config: aiConfig === undefined ? {} : { ai: structuredClone(aiConfig) }
    }
  }
}

const CONFIGURED = { provider: 'fake', providers: { fake: { apiKey: SECRET } } }

describe('refreshFromDisk', () => {
  let wikiHandle: { restore(): void }

  afterEach(() => {
    wikiHandle.restore()
  })

  test('a missing modules/ai directory is an empty list, not an error', async () => {
    wikiHandle = installTestWiki({ SERVERPATH: emptyServerPath })
    const errors = mock.fn()
    CARDINAL.logger.error = errors
    await ai.refreshFromDisk()
    assert.deepEqual(ai.definitions, [])
    assert.equal(errors.mock.callCount(), 0)
  })

  test('reads every definition, parsing props', async () => {
    wikiHandle = installTestWiki({ SERVERPATH: serverPath })
    await ai.refreshFromDisk()
    assert.deepEqual(
      ai.definitions.map((d) => d.key),
      ['fake', 'nocode']
    )
    const fake = ai.getDefinition('fake')
    assert.equal(fake?.props.apiKey.sensitive, true)
    assert.equal(fake?.props.apiKey.required, true)
    assert.equal(fake?.props.model.default, 'fake-model-1')
  })
})

describe('generate', () => {
  let wikiHandle: { restore(): void }
  let calls: { prompt: string; context: AiProviderContext; config: Record<string, any> }[]
  let respond: (context: AiProviderContext) => Promise<string | null>

  function install(aiConfig: Record<string, any> | undefined, config: Record<string, any> = {}) {
    wikiHandle = installTestWiki({ SERVERPATH: serverPath, config, sites: siteWith(aiConfig) })
  }

  before(async () => {
    const handle = installTestWiki({ SERVERPATH: serverPath })
    await ai.refreshFromDisk()
    handle.restore()
  })

  beforeEach(() => {
    calls = []
    respond = async () => 'generated text'
    ai.modules.fake = async (prompt, context, config) => {
      calls.push({ prompt, context, config })
      return respond(context)
    }
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('returns null, without calling a provider, when the site has no ai config at all', async () => {
    install(undefined)
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    assert.equal(calls.length, 0)
  })

  test('returns null when no provider is selected', async () => {
    install({ provider: '', providers: { fake: { apiKey: SECRET } } })
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    assert.equal(calls.length, 0)
  })

  test('returns null for a site that does not exist', async () => {
    install(CONFIGURED)
    assert.equal(await ai.generate('no-such-site', PROMPT), null)
    assert.equal(calls.length, 0)
  })

  test('returns null when the selected provider has no definition', async () => {
    install({ provider: 'gone', providers: {} })
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
  })

  test('returns null when the selected provider has no implementation', async () => {
    install({ provider: 'nocode', providers: { nocode: { apiKey: SECRET } } })
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
  })

  test('returns null when the required API key is missing', async () => {
    install({ provider: 'fake', providers: { fake: { apiKey: '' } } })
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    assert.equal(calls.length, 0)
  })

  test('returns null in offline mode', async () => {
    install(CONFIGURED, { offline: true })
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    assert.equal(calls.length, 0)
  })

  test('calls the provider with the prompt, context and completed config', async () => {
    install(CONFIGURED)
    const text = await ai.generate(SITE_ID, PROMPT, { system: 'be brief', maxOutputTokens: 256 })
    assert.equal(text, 'generated text')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, PROMPT)
    assert.equal(calls[0].context.siteId, SITE_ID)
    assert.equal(calls[0].context.system, 'be brief')
    assert.equal(calls[0].context.maxOutputTokens, 256)
    assert.ok(calls[0].context.signal instanceof AbortSignal)
    assert.deepEqual(calls[0].config, { apiKey: SECRET, model: 'fake-model-1' })
  })

  test('returns null, never throwing, when the provider throws', async () => {
    install(CONFIGURED)
    respond = async () => {
      throw new Error(`upstream said no to ${SECRET} about ${PROMPT}`)
    }
    const logged: unknown[][] = []
    const record = (...args: unknown[]) => {
      logged.push(args)
    }
    CARDINAL.logger.warn = record
    CARDINAL.logger.error = record
    CARDINAL.logger.info = record
    CARDINAL.logger.debug = record
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    assert.equal(logged.length, 1)
    const serialized = JSON.stringify(logged)
    assert.ok(!serialized.includes(SECRET), 'a log line must never carry the API key')
    assert.ok(!serialized.includes(PROMPT), 'a log line must never carry the prompt')
  })

  test('returns null when the provider throws synchronously', async () => {
    install(CONFIGURED)
    ai.modules.fake = () => {
      throw new Error('boom')
    }
    assert.equal(await ai.generate(SITE_ID, PROMPT), null)
  })

  test('returns null when the provider answers null, a non-string or blank text', async () => {
    install(CONFIGURED)
    for (const answer of [null, 42, '', '   \n']) {
      respond = async () => answer as any
      assert.equal(await ai.generate(SITE_ID, PROMPT), null)
    }
  })

  test('returns null once the timeout passes, and aborts the signal it handed the provider', async () => {
    install(CONFIGURED)
    let seen: AbortSignal | undefined
    respond = (context) => {
      seen = context.signal
      return new Promise(() => {})
    }
    const started = Date.now()
    assert.equal(await ai.generate(SITE_ID, PROMPT, { timeoutMs: 30 }), null)
    assert.ok(Date.now() - started < 5_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(seen?.aborted, true)
  })

  test("forwards the caller's abort to the provider and returns null without a warning", async () => {
    install(CONFIGURED)
    const warn = mock.fn()
    CARDINAL.logger.warn = warn
    const controller = new AbortController()
    respond = (context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const pending = ai.generate(SITE_ID, PROMPT, { signal: controller.signal })
    controller.abort()
    assert.equal(await pending, null)
    assert.equal(warn.mock.callCount(), 0)
  })
})

describe('availability', () => {
  let wikiHandle: { restore(): void }

  before(async () => {
    const handle = installTestWiki({ SERVERPATH: serverPath })
    await ai.refreshFromDisk()
    handle.restore()
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  const cases: [string, Record<string, any> | undefined, Record<string, any>, any][] = [
    ['no ai config', undefined, {}, { available: false, provider: null, reason: 'noProvider' }],
    [
      'unknown provider',
      { provider: 'gone' },
      {},
      { available: false, provider: null, reason: 'noProvider' }
    ],
    [
      'offline',
      CONFIGURED,
      { offline: true },
      { available: false, provider: 'fake', reason: 'offline' }
    ],
    [
      'no implementation',
      { provider: 'nocode', providers: { nocode: { apiKey: SECRET } } },
      {},
      { available: false, provider: 'nocode', reason: 'noImplementation' }
    ],
    [
      'missing API key',
      { provider: 'fake', providers: {} },
      {},
      { available: false, provider: 'fake', reason: 'notConfigured' }
    ],
    ['configured', CONFIGURED, {}, { available: true, provider: 'fake', reason: null }]
  ]

  for (const [label, aiConfig, config, expected] of cases) {
    test(label, async () => {
      wikiHandle = installTestWiki({ SERVERPATH: serverPath, config, sites: siteWith(aiConfig) })
      assert.deepEqual(await ai.availability(SITE_ID), expected)
    })
  }
})

describe('provider listing and selection', () => {
  let wikiHandle: { restore(): void }
  let updateCalls: any[]

  before(async () => {
    const handle = installTestWiki({ SERVERPATH: serverPath })
    await ai.refreshFromDisk()
    handle.restore()
  })

  beforeEach(() => {
    updateCalls = []
    wikiHandle = installTestWiki({
      SERVERPATH: serverPath,
      sites: siteWith(CONFIGURED),
      models: {
        sites: {
          updateSite: async (siteId: string, patch: any) => {
            updateCalls.push([siteId, patch])
            return true
          }
        }
      }
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('getSiteProviders masks the API key when asked and marks the selected provider', async () => {
    const providers = await ai.getSiteProviders(SITE_ID, { mask: true })
    const fake = providers.find((p) => p.key === 'fake')
    const nocode = providers.find((p) => p.key === 'nocode')
    assert.equal(fake?.config.apiKey, SENSITIVE_CONFIG_MASK)
    assert.equal(fake?.config.model, 'fake-model-1')
    assert.equal(fake?.isSelected, true)
    assert.equal(fake?.hasImplementation, true)
    assert.equal(nocode?.isSelected, false)
    assert.equal(nocode?.hasImplementation, false)
    assert.ok(!JSON.stringify(providers).includes(SECRET))
  })

  test('getSiteProviders leaves an empty API key unmasked', async () => {
    CARDINAL.sites[SITE_ID].config.ai.providers.fake.apiKey = ''
    const providers = await ai.getSiteProviders(SITE_ID, { mask: true })
    assert.equal(providers.find((p) => p.key === 'fake')?.config.apiKey, '')
  })

  test('selectProvider keeps the stored key when the mask is sent back', async () => {
    await ai.selectProvider(SITE_ID, 'fake', { apiKey: SENSITIVE_CONFIG_MASK, model: 'other' })
    assert.deepEqual(updateCalls, [
      [
        SITE_ID,
        {
          config: {
            ai: { provider: 'fake', providers: { fake: { apiKey: SECRET, model: 'other' } } }
          }
        }
      ]
    ])
  })

  test('selectProvider with an empty key turns AI off and leaves provider configs alone', async () => {
    await ai.selectProvider(SITE_ID, '')
    assert.deepEqual(updateCalls, [[SITE_ID, { config: { ai: { provider: '' } } }]])
  })

  test('validateProviderConfig refuses an undeclared key', () => {
    assert.match(ai.validateProviderConfig('fake', { bogus: 'x' }) ?? '', /bogus/)
  })

  test('validateProviderConfig refuses a missing API key, and accepts a stored one', () => {
    assert.match(ai.validateProviderConfig('fake', {}, {}) ?? '', /API Key/)
    assert.equal(
      ai.validateProviderConfig('fake', { apiKey: SENSITIVE_CONFIG_MASK }, { apiKey: SECRET }),
      null
    )
  })
})
