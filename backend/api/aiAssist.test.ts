import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { Mock } from 'node:test'
import type { FastifyInstance } from 'fastify'
import aiAssistRoutes from './aiAssist.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { AI_ASSIST_WINDOW_SECONDS } from '../helpers/aiAssist.ts'
import { generatePathHash } from '../helpers/common.ts'
import { ai } from '../models/ai.ts'

const SITE_ID = '11111111-1111-4111-8111-111111111111'
const PAGE_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const STATUS_URL = `/sites/${SITE_ID}/ai/status`
const GENERATE_URL = `/sites/${SITE_ID}/ai/generate`

describe('aiAssist routes', () => {
  let app: FastifyInstance
  let session: any
  let writable: boolean
  let siteConfig: Record<string, any>
  let peekMock: Mock<(...args: any[]) => any>
  let consumeMock: Mock<(...args: any[]) => any>
  let generateMock: Mock<(...args: any[]) => any>
  let getPageMock: Mock<(...args: any[]) => any>
  let checkAccessMock: Mock<(...args: any[]) => any>
  let availabilityMock: Mock<(...args: any[]) => any>
  let registry: Record<string, any> | undefined
  let offline: boolean

  before(async () => {
    app = await buildTestApp({
      routes: aiAssistRoutes,
      session: () => session,
      wiki: {
        get config() {
          return { offline }
        },
        get sites() {
          return { [SITE_ID]: { id: SITE_ID, isEnabled: true, config: siteConfig } }
        },
        models: {
          groups: {
            actorForRequest: () => ({ groupIds: [], permissions: [] }),
            checkAccess: (...args: any[]) => checkAccessMock(...args),
            groupIdsForRequest: () => []
          },
          pages: {
            getPage: (...args: any[]) => getPageMock(...args)
          },
          rateLimits: {
            peek: (...args: any[]) => peekMock(...args),
            consume: (...args: any[]) => consumeMock(...args)
          },
          get ai() {
            return registry
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    session = { authenticated: true, user: { id: USER_ID }, permissions: [] }
    writable = true
    offline = false
    availabilityMock = mock.fn(async () => ({
      available: true,
      provider: 'anthropic',
      reason: null
    }))
    registry = {
      availability: (...args: any[]) => availabilityMock(...args),
      generate: (...args: any[]) => generateMock(...args)
    }
    siteConfig = {
      ai: { provider: 'anthropic', providers: {}, assist: true, assistDailyCap: 5 }
    }
    checkAccessMock = mock.fn(() => writable)
    peekMock = mock.fn(async () => ({ allowed: true, hits: 2, retryAfter: 0, resetsIn: 3600 }))
    consumeMock = mock.fn(async () => ({ allowed: true, hits: 3, retryAfter: 0 }))
    generateMock = mock.fn(async () => 'Improved text.')
    getPageMock = mock.fn(async () => ({
      id: PAGE_ID,
      path: 'docs/page',
      locale: 'en',
      tags: ['t'],
      isLocked: false
    }))
  })

  function generate(body: Record<string, any> = {}) {
    return app.inject({
      method: 'POST',
      url: GENERATE_URL,
      payload: { action: 'rewrite', text: 'Some text', path: 'docs/page', locale: 'en', ...body }
    })
  }

  describe('GET status', () => {
    test('a guest is reported unavailable, reason guest, and the counter is never read', async () => {
      session = { authenticated: false }
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), {
        available: false,
        reason: 'guest',
        cap: 5,
        remaining: 0,
        retryAfter: 0
      })
      assert.equal(peekMock.mock.calls.length, 0)
    })

    test('the site flag off reports reason disabled before any permission or counter check', async () => {
      siteConfig.ai.assist = false
      const res = await app.inject({ method: 'GET', url: `${STATUS_URL}?path=docs/page&locale=en` })
      assert.equal(res.json().reason, 'disabled')
      assert.equal(res.json().available, false)
      assert.equal(checkAccessMock.mock.calls.length, 0)
      assert.equal(peekMock.mock.calls.length, 0)
    })

    test('the flag absent altogether counts as off', async () => {
      delete siteConfig.ai.assist
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.equal(res.json().reason, 'disabled')
    })

    test('no write:pages at the path reports reason forbidden', async () => {
      writable = false
      const res = await app.inject({ method: 'GET', url: `${STATUS_URL}?path=docs/page&locale=en` })
      assert.equal(res.json().reason, 'forbidden')
      assert.equal(checkAccessMock.mock.calls[0]?.arguments[1], 'write:pages')
      assert.equal(peekMock.mock.calls.length, 0)
    })

    test('with no page named, the write:pages check is skipped', async () => {
      writable = false
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.equal(res.json().available, true)
      assert.equal(checkAccessMock.mock.calls.length, 0)
    })

    test('under the cap it is available, with the remaining allowance, and nothing is consumed', async () => {
      const res = await app.inject({ method: 'GET', url: `${STATUS_URL}?path=docs/page&locale=en` })
      assert.deepEqual(res.json(), {
        available: true,
        reason: null,
        cap: 5,
        remaining: 3,
        retryAfter: 0
      })
      assert.equal(consumeMock.mock.calls.length, 0)
      const [key, policy] = peekMock.mock.calls[0]!.arguments
      assert.equal(key, `ai-assist:${SITE_ID}:${USER_ID}`)
      assert.equal(policy.max, 5)
      assert.equal(policy.windowSeconds, AI_ASSIST_WINDOW_SECONDS)
    })

    test('with the cap used up it reports reason capReached and when to retry', async () => {
      peekMock = mock.fn(async () => ({ allowed: false, hits: 5, retryAfter: 900, resetsIn: 900 }))
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.deepEqual(res.json(), {
        available: false,
        reason: 'capReached',
        cap: 5,
        remaining: 0,
        retryAfter: 900
      })
    })

    test('with no provider available it reports reason unconfigured', async () => {
      availabilityMock = mock.fn(async () => ({
        available: false,
        provider: null,
        reason: 'noProvider'
      }))
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.equal(res.json().reason, 'unconfigured')
      assert.equal(res.json().available, false)
      assert.equal(res.json().remaining, 3)
      assert.equal(availabilityMock.mock.calls[0]?.arguments[0], SITE_ID)
    })

    test('an unusable stored cap falls back to the default of 50', async () => {
      siteConfig.ai.assistDailyCap = 'lots'
      const res = await app.inject({ method: 'GET', url: STATUS_URL })
      assert.equal(res.json().cap, 50)
      assert.equal(peekMock.mock.calls[0]!.arguments[1].max, 50)
    })
  })

  describe('POST generate', () => {
    test('a guest gets 401 and neither the counter nor the provider is touched', async () => {
      session = { authenticated: false }
      const res = await generate()
      assert.equal(res.statusCode, 401)
      assert.equal(peekMock.mock.calls.length, 0)
      assert.equal(consumeMock.mock.calls.length, 0)
      assert.equal(generateMock.mock.calls.length, 0)
    })

    test('the site flag off answers 403 before write:pages is consulted or the provider is reached', async () => {
      siteConfig.ai.assist = false
      const res = await generate()
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /disabled for this site/)
      assert.equal(checkAccessMock.mock.calls.length, 0)
      assert.equal(consumeMock.mock.calls.length, 0)
      assert.equal(generateMock.mock.calls.length, 0)
    })

    test('no write:pages on the page answers 403 and uses no allowance', async () => {
      writable = false
      const res = await generate()
      assert.equal(res.statusCode, 403)
      assert.equal(peekMock.mock.calls.length, 0)
      assert.equal(consumeMock.mock.calls.length, 0)
      assert.equal(generateMock.mock.calls.length, 0)
    })

    test('with a pageId, write:pages is judged on the stored page', async () => {
      const res = await generate({ pageId: PAGE_ID })
      assert.equal(res.statusCode, 200)
      assert.equal(getPageMock.mock.calls[0]?.arguments[0].id, PAGE_ID)
      const writeCheck = checkAccessMock.mock.calls.find(
        (call: any) => call.arguments[1] === 'write:pages'
      )
      assert.deepEqual(writeCheck?.arguments[2].tags, ['t'])
    })

    test('a pageId the caller cannot read answers 403, the same as one they cannot edit', async () => {
      getPageMock = mock.fn(async () => null)
      const res = await generate({ pageId: PAGE_ID })
      assert.equal(res.statusCode, 403)
      assert.equal(generateMock.mock.calls.length, 0)
    })

    describe('without a pageId, a page already at the path', () => {
      const SECRET_PAGE = {
        id: PAGE_ID,
        path: 'docs/secret',
        locale: 'en',
        tags: ['secret'],
        classification: null,
        isLocked: false
      }

      beforeEach(() => {
        getPageMock = mock.fn(async () => SECRET_PAGE)
        // -> A TAG DENY on `secret` for write:pages: nothing else is refused.
        checkAccessMock = mock.fn(
          (_actor: any, permission: string, page: any) =>
            !(permission === 'write:pages' && (page.tags ?? []).includes('secret'))
        )
      })

      test('is looked up by its normalized path and locale', async () => {
        await generate({ path: '/Docs/Secret/', locale: 'en' })
        const lookup = getPageMock.mock.calls[0]?.arguments[0]
        assert.equal(lookup.siteId, SITE_ID)
        assert.equal(lookup.hash, generatePathHash('docs/secret'))
        assert.equal(lookup.locale, 'en')
      })

      test('is judged as that page, so a tag DENY on write:pages answers 403', async () => {
        const res = await generate({ path: 'docs/secret', locale: 'en' })
        assert.equal(res.statusCode, 403)
        assert.equal(consumeMock.mock.calls.length, 0)
        assert.equal(generateMock.mock.calls.length, 0)
      })

      test('answers the same 403 as naming it by pageId', async () => {
        const byPath = await generate({ path: 'docs/secret', locale: 'en' })
        const byId = await generate({ path: 'docs/secret', locale: 'en', pageId: PAGE_ID })
        assert.equal(byPath.statusCode, 403)
        assert.equal(byId.statusCode, 403)
      })

      test('the caller cannot read answers 403, even with write:pages on it', async () => {
        checkAccessMock = mock.fn((_actor: any, permission: string) => permission !== 'read:pages')
        const res = await generate({ path: 'docs/secret', locale: 'en' })
        assert.equal(res.statusCode, 403)
        assert.equal(generateMock.mock.calls.length, 0)
      })

      test('is reported forbidden by the status route too', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `${STATUS_URL}?path=docs/secret&locale=en`
        })
        assert.equal(res.json().reason, 'forbidden')
      })
    })

    test('without a pageId and with no page at the path, write:pages is judged on the path', async () => {
      getPageMock = mock.fn(async () => null)
      const res = await generate({ path: '/Docs/New-Page', locale: 'en' })
      assert.equal(res.statusCode, 200)
      const writeCheck = checkAccessMock.mock.calls.find(
        (call: any) => call.arguments[1] === 'write:pages'
      )
      assert.deepEqual(writeCheck?.arguments[2], {
        path: 'docs/new-page',
        locale: 'en',
        classification: null,
        siteId: SITE_ID
      })
    })

    test('with the cap used up it answers 429 with Retry-After and never calls the provider', async () => {
      peekMock = mock.fn(async () => ({
        allowed: false,
        hits: 5,
        retryAfter: 7200,
        resetsIn: 7200
      }))
      const res = await generate()
      assert.equal(res.statusCode, 429)
      assert.equal(res.headers['retry-after'], '7200')
      assert.match(res.json().message, /daily writing assistant limit/)
      assert.equal(consumeMock.mock.calls.length, 0)
      assert.equal(generateMock.mock.calls.length, 0)
    })

    test('a concurrent request taking the last unit is refused 429 by the consume itself', async () => {
      consumeMock = mock.fn(async () => ({ allowed: false, hits: 6, retryAfter: 3600 }))
      const res = await generate()
      assert.equal(res.statusCode, 429)
      assert.equal(res.headers['retry-after'], '3600')
      assert.equal(generateMock.mock.calls.length, 0)
    })

    for (const reason of ['noProvider', 'offline', 'noImplementation', 'notConfigured']) {
      test(`an unavailable provider (${reason}) answers 503 without using any allowance`, async () => {
        availabilityMock = mock.fn(async () => ({ available: false, provider: null, reason }))
        const res = await generate()
        assert.equal(res.statusCode, 503)
        assert.match(res.json().message, /No AI provider is available/)
        assert.equal(consumeMock.mock.calls.length, 0)
        assert.equal(generateMock.mock.calls.length, 0)
      })
    }

    test('offline mode, through the real AI registry, answers 503 without using any allowance', async () => {
      await ai.refreshFromDisk()
      try {
        assert.ok(ai.getDefinition('anthropic'), 'the anthropic provider module is installed')
        registry = ai
        offline = true
        const res = await generate()
        assert.equal(res.statusCode, 503)
        assert.equal(consumeMock.mock.calls.length, 0)
        assert.equal(generateMock.mock.calls.length, 0)
      } finally {
        ai.definitions = []
      }
    })

    test('no AI registry loaded answers 503 without using any allowance', async () => {
      registry = undefined
      const res = await generate()
      assert.equal(res.statusCode, 503)
      assert.equal(consumeMock.mock.calls.length, 0)
    })

    test('under the cap: one unit is consumed, then the provider runs, and its text is returned', async () => {
      const res = await generate({ action: 'summarize', text: 'Long passage.' })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { text: 'Improved text.' })

      assert.equal(consumeMock.mock.calls.length, 1)
      const [key, policy] = consumeMock.mock.calls[0]!.arguments
      assert.equal(key, `ai-assist:${SITE_ID}:${USER_ID}`)
      assert.equal(policy.max, 5)
      assert.equal(policy.windowSeconds, AI_ASSIST_WINDOW_SECONDS)
      assert.equal(policy.banSeconds, 3600, 'going over must not outlast the current window')

      const [siteId, prompt, context] = generateMock.mock.calls[0]!.arguments
      assert.equal(siteId, SITE_ID)
      assert.match(prompt, /Summarize/)
      assert.match(prompt, /<text>\nLong passage\.\n<\/text>/)
      assert.equal(typeof context.system, 'string')
      assert.ok(context.maxOutputTokens > 0)
    })

    test('a provider returning null answers 503, and the unit it used is not refunded', async () => {
      generateMock = mock.fn(async () => null)
      const res = await generate()
      assert.equal(res.statusCode, 503)
      assert.equal(consumeMock.mock.calls.length, 1)
    })

    test('a provider that throws is treated like one returning null', async () => {
      generateMock = mock.fn(async () => {
        throw new Error('boom')
      })
      const res = await generate()
      assert.equal(res.statusCode, 503)
    })

    test('generate runs the author prompt through the provider', async () => {
      const res = await generate({ action: 'generate', text: '', prompt: 'A table of planets' })
      assert.equal(res.statusCode, 200)
      const prompt = generateMock.mock.calls[0]!.arguments[1]
      assert.match(prompt, /<request>\nA table of planets\n<\/request>/)
      assert.match(prompt, /locale code "en"/)
    })

    test('rewrite and summarize refuse an empty selection with 400', async () => {
      for (const action of ['rewrite', 'summarize']) {
        const res = await generate({ action, text: '   ' })
        assert.equal(res.statusCode, 400, action)
      }
      assert.equal(consumeMock.mock.calls.length, 0)
    })

    test('generate refuses a missing prompt with 400', async () => {
      const res = await generate({ action: 'generate', text: '' })
      assert.equal(res.statusCode, 400)
    })

    test('the body is bounded: an unknown action, over-long text or prompt is 400', async () => {
      assert.equal((await generate({ action: 'translate' })).statusCode, 400)
      assert.equal((await generate({ text: 'x'.repeat(20001) })).statusCode, 400)
      assert.equal(
        (await generate({ action: 'generate', prompt: 'x'.repeat(2001) })).statusCode,
        400
      )
      assert.equal(generateMock.mock.calls.length, 0)
    })
  })
})
