import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, mock, test } from 'node:test'
import {
  AI_ASSIST_DEFAULT_DAILY_CAP,
  AI_ASSIST_MAX_DAILY_CAP,
  AI_ASSIST_WINDOW_SECONDS,
  aiAssistDailyCap,
  aiAssistEnabled,
  aiAssistPolicy,
  aiRegistry,
  buildAiAssistPrompt,
  consumeAiAssistQuota,
  evaluateAiAssist
} from './aiAssist.ts'
import { ai } from '../models/ai.ts'
import { installTestWiki } from '../test/mocks.ts'

const SITE_ID = 'site-1'
const USER_ID = 'user-1'

describe('aiAssist config readers', () => {
  test('the flag is on only when it is literally true', () => {
    assert.equal(aiAssistEnabled({ features: { aiAssist: true } }), true)
    assert.equal(aiAssistEnabled({ features: { aiAssist: 'true' } }), false)
    assert.equal(aiAssistEnabled({ features: {} }), false)
    assert.equal(aiAssistEnabled(undefined), false)
  })

  test('the daily cap falls back to the default when missing or unusable, and is clamped', () => {
    assert.equal(aiAssistDailyCap({ features: { aiAssistDailyCap: 10 } }), 10)
    assert.equal(aiAssistDailyCap({ features: { aiAssistDailyCap: 7.9 } }), 7)
    assert.equal(aiAssistDailyCap({ features: {} }), AI_ASSIST_DEFAULT_DAILY_CAP)
    assert.equal(
      aiAssistDailyCap({ features: { aiAssistDailyCap: 0 } }),
      AI_ASSIST_DEFAULT_DAILY_CAP
    )
    assert.equal(
      aiAssistDailyCap({ features: { aiAssistDailyCap: 'x' } }),
      AI_ASSIST_DEFAULT_DAILY_CAP
    )
    assert.equal(aiAssistDailyCap({ features: { aiAssistDailyCap: 1e9 } }), AI_ASSIST_MAX_DAILY_CAP)
    assert.equal(aiAssistDailyCap(undefined), AI_ASSIST_DEFAULT_DAILY_CAP)
  })

  test('the policy is a fixed 24h window whose ban never outlasts it', () => {
    assert.deepEqual(aiAssistPolicy(5), {
      max: 5,
      windowSeconds: AI_ASSIST_WINDOW_SECONDS,
      banSeconds: AI_ASSIST_WINDOW_SECONDS
    })
    assert.equal(aiAssistPolicy(5, 120).banSeconds, 120)
    assert.equal(aiAssistPolicy(5, 0).banSeconds, 1)
    assert.equal(
      aiAssistPolicy(5, 10 * AI_ASSIST_WINDOW_SECONDS).banSeconds,
      AI_ASSIST_WINDOW_SECONDS
    )
  })
})

describe('evaluateAiAssist: the gate in front of the provider call', () => {
  let handle: { restore(): void } | null = null

  afterEach(() => {
    handle?.restore()
    handle = null
  })

  const AVAILABLE = { available: true, provider: 'anthropic', reason: null }

  function install(
    features: Record<string, any>,
    peek: (...args: any[]) => Promise<any>,
    {
      registry = { availability: async () => AVAILABLE, generate: async () => 'ok' },
      aiConfig = { provider: 'anthropic', providers: {} },
      config = {},
      serverPath
    }: {
      registry?: Record<string, any> | null
      aiConfig?: Record<string, any>
      config?: Record<string, any>
      serverPath?: string
    } = {}
  ) {
    const peekMock = mock.fn(peek)
    const consumeMock = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    handle = installTestWiki({
      ...(serverPath ? { SERVERPATH: serverPath } : {}),
      config,
      sites: {
        [SITE_ID]: {
          id: SITE_ID,
          config: { features, ai: structuredClone(aiConfig) }
        }
      },
      models: {
        groups: {
          actorForRequest: () => ({ groupIds: [], permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        },
        rateLimits: { peek: peekMock, consume: consumeMock },
        ...(registry ? { ai: registry } : {})
      }
    })
    return Object.assign(peekMock, { consumeMock })
  }

  const req = { session: { authenticated: true, user: { id: USER_ID }, permissions: [] } } as any
  const target = { path: 'a/page', locale: 'en' }

  test('flag off: refused as disabled, before the counter is even read', async () => {
    const peek = install({ aiAssist: false }, async () => ({ allowed: true, hits: 0 }))
    const { status } = await evaluateAiAssist(req, SITE_ID, target)
    assert.equal(status.available, false)
    assert.equal(status.reason, 'disabled')
    assert.equal(peek.mock.calls.length, 0)
  })

  test('flag on and under the cap: the check passes', async () => {
    install({ aiAssist: true, aiAssistDailyCap: 3 }, async () => ({
      allowed: true,
      hits: 1,
      retryAfter: 0,
      resetsIn: 50
    }))
    const { status, userId, counter } = await evaluateAiAssist(req, SITE_ID, target)
    assert.deepEqual(status, { available: true, reason: null, cap: 3, remaining: 2, retryAfter: 0 })
    assert.equal(userId, USER_ID)
    assert.equal(counter?.resetsIn, 50)
  })

  test('cap exhausted: refused as capReached, with when to retry', async () => {
    install({ aiAssist: true, aiAssistDailyCap: 3 }, async () => ({
      allowed: false,
      hits: 3,
      retryAfter: 600,
      resetsIn: 600
    }))
    const { status } = await evaluateAiAssist(req, SITE_ID, target)
    assert.deepEqual(status, {
      available: false,
      reason: 'capReached',
      cap: 3,
      remaining: 0,
      retryAfter: 600
    })
  })

  test('capReached is still reported ahead of an unavailable provider', async () => {
    const availability = mock.fn(async () => ({
      available: false,
      provider: null,
      reason: 'noProvider'
    }))
    install(
      { aiAssist: true, aiAssistDailyCap: 3 },
      async () => ({ allowed: false, hits: 3, retryAfter: 600, resetsIn: 600 }),
      { registry: { availability, generate: async () => 'ok' } }
    )
    const { status } = await evaluateAiAssist(req, SITE_ID, target)
    assert.equal(status.reason, 'capReached')
    assert.equal(availability.mock.calls.length, 0)
  })

  test('no AI registry loaded: refused as unconfigured', async () => {
    install({ aiAssist: true }, async () => ({ allowed: true, hits: 0 }), { registry: null })
    const { status } = await evaluateAiAssist(req, SITE_ID, target)
    assert.equal(status.available, false)
    assert.equal(status.reason, 'unconfigured')
  })

  describe('provider availability, through the real AI registry', () => {
    let serverPath: string

    before(async () => {
      serverPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-ai-assist-'))
      const definition = (key: string) =>
        [
          `key: ${key}`,
          `title: ${key}`,
          'description: A test provider.',
          'vendor: Test',
          'website: https://example.test',
          'props:',
          '  apiKey:',
          '    type: String',
          '    sensitive: true',
          '    required: true',
          ''
        ].join('\n')
      for (const key of ['fake', 'nocode']) {
        await fs.mkdir(path.join(serverPath, 'modules/ai', key), { recursive: true })
        await fs.writeFile(
          path.join(serverPath, 'modules/ai', key, 'definition.yml'),
          definition(key)
        )
      }
      await fs.writeFile(path.join(serverPath, 'modules/ai/fake/ai.ts'), 'export default null\n')
      const refresh = installTestWiki({ SERVERPATH: serverPath })
      await ai.refreshFromDisk()
      refresh.restore()
    })

    after(async () => {
      ai.definitions = []
      await fs.rm(serverPath, { recursive: true, force: true })
    })

    const CONFIGURED = { provider: 'fake', providers: { fake: { apiKey: 'sk-test' } } }
    const cases: [string, Record<string, any>, Record<string, any>][] = [
      ['no provider selected', { provider: '', providers: {} }, {}],
      ['a provider with no definition', { provider: 'gone', providers: {} }, {}],
      ['offline mode', CONFIGURED, { offline: true }],
      [
        'a provider module with no ai.ts',
        { provider: 'nocode', providers: { nocode: { apiKey: 'sk-test' } } },
        {}
      ],
      ['stored provider config that fails validation', { provider: 'fake', providers: {} }, {}]
    ]

    for (const [label, aiConfig, config] of cases) {
      test(`${label}: refused as unconfigured, and no quota is used`, async () => {
        const peek = install(
          { aiAssist: true, aiAssistDailyCap: 3 },
          async () => ({ allowed: true, hits: 1, retryAfter: 0, resetsIn: 50 }),
          { registry: ai, aiConfig, config, serverPath }
        )
        const { status } = await evaluateAiAssist(req, SITE_ID, target)
        assert.deepEqual(status, {
          available: false,
          reason: 'unconfigured',
          cap: 3,
          remaining: 2,
          retryAfter: 0
        })
        assert.equal(peek.consumeMock.mock.calls.length, 0)
      })
    }

    test('a selected, implemented and valid provider passes', async () => {
      install({ aiAssist: true }, async () => ({ allowed: true, hits: 0, retryAfter: 0 }), {
        registry: ai,
        aiConfig: CONFIGURED,
        serverPath
      })
      const { status } = await evaluateAiAssist(req, SITE_ID, target)
      assert.equal(status.available, true)
      assert.equal(status.reason, null)
    })
  })

  test('consumeAiAssistQuota bans an over-cap attempt only until the current window ends', async () => {
    const consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    handle = installTestWiki({ models: { rateLimits: { consume } } })
    await consumeAiAssistQuota(SITE_ID, USER_ID, 4, {
      allowed: true,
      hits: 0,
      retryAfter: 0,
      resetsIn: 42
    })
    await consumeAiAssistQuota(SITE_ID, USER_ID, 4, {
      allowed: true,
      hits: 0,
      retryAfter: 0,
      resetsIn: 0
    })
    const [first, second] = consume.mock.calls.map((call: any) => call.arguments)
    assert.equal(first[0], `ai-assist:${SITE_ID}:${USER_ID}`)
    assert.equal(first[1].banSeconds, 42)
    assert.equal(second[1].banSeconds, AI_ASSIST_WINDOW_SECONDS)
  })
})

describe('buildAiAssistPrompt', () => {
  test('every action carries the same system prompt and a positive output ceiling', () => {
    for (const action of ['rewrite', 'summarize', 'expand', 'generate'] as const) {
      const built = buildAiAssistPrompt({ action, text: 'Body', prompt: 'Ask', locale: 'en' })
      assert.match(built.system, /Markdown editor/)
      assert.ok(built.maxOutputTokens > 0, action)
    }
  })

  test('the author text is fenced in <text> tags, never spliced in bare', () => {
    const built = buildAiAssistPrompt({ action: 'rewrite', text: 'Hello there', locale: 'en' })
    assert.match(built.prompt, /^Rewrite/)
    assert.match(built.prompt, /<text>\nHello there\n<\/text>/)
    assert.match(built.prompt, /same language as the text/)
  })

  test('expand asks for only the continuation', () => {
    const built = buildAiAssistPrompt({ action: 'expand', text: 'Once', locale: 'en' })
    assert.match(built.prompt, /Continue writing/)
    assert.match(built.prompt, /only the new text/)
  })

  test('generate with no surrounding text names the page locale and omits the <text> block', () => {
    const built = buildAiAssistPrompt({
      action: 'generate',
      text: '',
      prompt: 'A list',
      locale: 'fr'
    })
    assert.match(built.prompt, /<request>\nA list\n<\/request>/)
    assert.match(built.prompt, /locale code "fr"/)
    assert.doesNotMatch(built.prompt, /<text>/)
  })

  test('generate with surrounding text includes it as context', () => {
    const built = buildAiAssistPrompt({
      action: 'generate',
      text: 'Context here',
      prompt: 'Add a row',
      locale: 'en'
    })
    assert.match(built.prompt, /context only/)
    assert.match(built.prompt, /<text>\nContext here\n<\/text>/)
  })
})

describe('aiRegistry', () => {
  let handle: { restore(): void } | null = null

  afterEach(() => {
    handle?.restore()
    handle = null
  })

  test('is null while no AI registry is loaded', () => {
    handle = installTestWiki({ models: {} })
    assert.equal(aiRegistry(), null)
  })

  test('is null while the loaded registry cannot report availability', () => {
    handle = installTestWiki({ models: { ai: { generate: async () => 'ok' } } })
    assert.equal(aiRegistry(), null)
  })

  test('returns the loaded registry', () => {
    const registry = { availability: async () => ({ available: true }), generate: async () => 'ok' }
    handle = installTestWiki({ models: { ai: registry } })
    assert.equal(aiRegistry(), registry)
  })
})
