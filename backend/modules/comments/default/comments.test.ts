import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'
import { createSilentLogger, installTestWiki } from '../../../test/mocks.ts'
import commentsDefaultModule, {
  _resetAkismetKeyCacheForTesting,
  checkRateLimit
} from './comments.ts'
import type { CheckSpamParams } from './comments.ts'

/**
 * `checkSpam` reads `CARDINAL.config.host` (the Akismet "blog" identity) and `CARDINAL.logger.warn`
 * (fail-open logging), so a stub of just those two is enough — nothing here touches the database.
 * The whole record is captured rather than the message alone because the cause of a fail-open is
 * passed as `fields.error`, not written into the message.
 */
interface WarnRecord {
  scope: string
  message: string
  fields?: Record<string, unknown>
}
const warnLog: WarnRecord[] = []
installTestWiki({
  config: { host: 'https://test.wiki' },
  // -> Not the silent default: tests assert on the fail-open warning this module emits.
  logger: {
    ...createSilentLogger(),
    warn: (scope: string, message: string, fields?: Record<string, unknown>) =>
      warnLog.push({ scope, message, fields })
  }
})

function warnText(record: WarnRecord): string {
  const error = record.fields?.error
  return error instanceof Error ? `${record.message}: ${error.message}` : record.message
}

/**
 * A stand-in for the `Temporal` subset `checkRateLimit` and this file's fixtures use, for a Node
 * build compiled without Temporal support. `Instant.compare` implements the real
 * `(a, b) => sign(a - b)` semantics, so what is exercised is `checkRateLimit`'s own comparison
 * rather than a re-implementation of it.
 */
if (typeof (globalThis as any).Temporal === 'undefined') {
  const durationToMs = (d: { seconds?: number }) => (d.seconds ?? 0) * 1_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    add: (d: any) => makeInstant(epochMs + durationToMs(d)),
    subtract: (d: any) => makeInstant(epochMs - durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = {
    Now: { instant: () => makeInstant(Date.now()) },
    Instant: {
      compare: (a: any, b: any) => Math.sign(a.epochMilliseconds - b.epochMilliseconds)
    }
  }
}

function textResponse(body: string, init: { status?: number; statusText?: string } = {}): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => body
  } as Response
}

/**
 * `verifyKey`/`commentCheck` are each either the literal text Akismet would answer with, or an
 * `Error` for `fetch` itself to reject with — a network failure, as opposed to a successful but
 * non-2xx response.
 */
function mockAkismetFetch({
  verifyKey = 'valid',
  commentCheck = 'false'
}: {
  verifyKey?: string | Error
  commentCheck?: string | Error
} = {}) {
  return mock.method(globalThis, 'fetch', async (url: string | URL, _init?: RequestInit) => {
    const href = String(url)
    if (href === 'https://rest.akismet.com/1.1/verify-key') {
      if (verifyKey instanceof Error) throw verifyKey
      return textResponse(verifyKey)
    }
    if (href.endsWith('.rest.akismet.com/1.1/comment-check')) {
      if (commentCheck instanceof Error) throw commentCheck
      return textResponse(commentCheck)
    }
    throw new Error(`mockAkismetFetch: unexpected URL ${href}`)
  })
}

function baseSpamParams(overrides: Partial<CheckSpamParams> = {}): CheckSpamParams {
  return {
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Test)',
    content: 'Nice post!',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    permalink: 'https://test.wiki/en/some-page',
    permalinkDate: '2026-08-16T00:00:00.000Z',
    type: 'comment',
    role: 'user',
    ...overrides
  }
}

describe('modules/comments/default', () => {
  describe('comments.ts', () => {
    afterEach(() => {
      warnLog.length = 0
      _resetAkismetKeyCacheForTesting()
      mock.restoreAll()
    })

    it('is importable and exposes the CommentProviderModule contract', () => {
      assert.equal(typeof commentsDefaultModule.render, 'function')
      assert.equal(typeof commentsDefaultModule.checkSpam, 'function')
      assert.equal(typeof commentsDefaultModule.checkRateLimit, 'function')
    })

    describe('checkRateLimit', () => {
      const now = Temporal.Now.instant()

      it('allows a first post: no prior comment at all', () => {
        assert.equal(checkRateLimit(30, undefined, now), true)
        assert.equal(checkRateLimit(30, null, now), true)
      })

      it('disables rate limiting entirely when minDelay is 0', () => {
        const justNow = now.subtract({ seconds: 1 })
        assert.equal(checkRateLimit(0, justNow, now), true)
      })

      it('disallows a post strictly inside the configured window', () => {
        const fiveSecondsAgo = now.subtract({ seconds: 5 })
        assert.equal(checkRateLimit(30, fiveSecondsAgo, now), false)
      })

      it('disallows a post exactly at the boundary minus one instant (still too soon)', () => {
        const justUnderThirty = now.subtract({ seconds: 29 })
        assert.equal(checkRateLimit(30, justUnderThirty, now), false)
      })

      it('allows a post exactly at the boundary (cutoff reached, not just passed)', () => {
        const exactlyThirtyAgo = now.subtract({ seconds: 30 })
        assert.equal(checkRateLimit(30, exactlyThirtyAgo, now), true)
      })

      it('allows a post once the window has fully elapsed', () => {
        const anHourAgo = now.subtract({ seconds: 3600 })
        assert.equal(checkRateLimit(30, anHourAgo, now), true)
      })

      it('is a pure function of its arguments: same inputs, same output, no side effects', () => {
        const twentyAgo = now.subtract({ seconds: 20 })
        assert.equal(checkRateLimit(30, twentyAgo, now), checkRateLimit(30, twentyAgo, now))
      })

      it('module.checkRateLimit reads minDelay off conf and delegates to the pure function', async () => {
        const tenAgo = now.subtract({ seconds: 10 })
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, { minDelay: 30 }),
          false
        )
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, { minDelay: 5 }),
          true
        )
      })

      it('module.checkRateLimit treats a missing/non-numeric minDelay as disabled (0)', async () => {
        const tenAgo = now.subtract({ seconds: 10 })
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, {}),
          true
        )
      })

      it("guest pooling is the caller's job: two different callers sharing one lastCommentAt are rate-limited together", () => {
        // -> This module has no notion of "guest": it only compares the instant it is handed.
        const sharedGuestBucketLastCommentAt = now.subtract({ seconds: 2 })
        const guestPosterOneAllowed = checkRateLimit(30, sharedGuestBucketLastCommentAt, now)
        const guestPosterTwoAllowed = checkRateLimit(30, sharedGuestBucketLastCommentAt, now)
        assert.equal(guestPosterOneAllowed, false)
        assert.equal(guestPosterTwoAllowed, false)
      })
    })

    describe('checkSpam', () => {
      it('is a no-op (not spam, no request, no warning) when conf.akismet is empty', async () => {
        const fetchMock = mockAkismetFetch()

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: '' })

        assert.deepEqual(result, { isSpam: false })
        assert.equal(fetchMock.mock.callCount(), 0)
        assert.deepEqual(warnLog, [])
      })

      it('is a no-op when the akismet prop is left unset entirely', async () => {
        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {})
        assert.deepEqual(result, { isSpam: false })
      })

      it('returns isSpam: true when Akismet reports the comment as spam', async () => {
        mockAkismetFetch({ verifyKey: 'valid', commentCheck: 'true' })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.deepEqual(result, { isSpam: true })
      })

      it('returns isSpam: false when Akismet reports the comment as ham', async () => {
        mockAkismetFetch({ verifyKey: 'valid', commentCheck: 'false' })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.deepEqual(result, { isSpam: false })
      })

      it('POSTs the comment-check request to the key-scoped Akismet host with the mapped field set', async () => {
        const fetchMock = mockAkismetFetch({ verifyKey: 'valid', commentCheck: 'false' })

        await commentsDefaultModule.checkSpam(
          baseSpamParams({ type: 'reply', role: 'administrator' }),
          { akismet: 'valid-key' }
        )

        const commentCheckCall = fetchMock.mock.calls.find((call) =>
          String(call.arguments[0]).includes('comment-check')
        )
        assert.ok(commentCheckCall)
        assert.equal(
          commentCheckCall.arguments[0],
          'https://valid-key.rest.akismet.com/1.1/comment-check'
        )
        const init = commentCheckCall.arguments[1] as RequestInit
        assert.equal(init.method, 'POST')
        const body = init.body as URLSearchParams
        assert.deepEqual(Object.fromEntries(body.entries()), {
          blog: 'https://test.wiki',
          user_ip: '203.0.113.5',
          user_agent: 'Mozilla/5.0 (Test)',
          comment_content: 'Nice post!',
          comment_author: 'Ada Lovelace',
          comment_author_email: 'ada@example.com',
          permalink: 'https://test.wiki/en/some-page',
          // -> Deliberately not `comment_date_gmt`; `submitAkismetCommentCheck` says why.
          comment_post_modified_gmt: '2026-08-16T00:00:00.000Z',
          comment_type: 'reply',
          user_role: 'administrator'
        })
      })

      it('POSTs the verify-key request with the akismet key and CARDINAL.config.host as the blog', async () => {
        const fetchMock = mockAkismetFetch()

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'my-key' })

        const verifyKeyCall = fetchMock.mock.calls.find((call) =>
          String(call.arguments[0]).includes('verify-key')
        )
        assert.ok(verifyKeyCall)
        assert.equal(verifyKeyCall.arguments[0], 'https://rest.akismet.com/1.1/verify-key')
        const init = verifyKeyCall.arguments[1] as RequestInit
        const body = init.body as URLSearchParams
        assert.deepEqual(Object.fromEntries(body.entries()), {
          key: 'my-key',
          blog: 'https://test.wiki'
        })
      })

      it('fails open (not spam) and logs a warning, without throwing, when the key is invalid', async () => {
        mockAkismetFetch({ verifyKey: 'invalid' })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'bad-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnText(warnLog[0]!), /rejected/i)
      })

      it('fails open and logs a warning, without throwing, when verify-key rejects (Akismet unreachable)', async () => {
        mockAkismetFetch({ verifyKey: new Error('ENOTFOUND rest.akismet.com') })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'some-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnText(warnLog[0]!), /ENOTFOUND/)
      })

      it('fails open and logs a warning when comment-check itself fails, after a valid key', async () => {
        mockAkismetFetch({
          verifyKey: 'valid',
          commentCheck: new Error('502 Bad Gateway')
        })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnText(warnLog[0]!), /502 Bad Gateway/)
      })

      it('fails open when comment-check answers a non-2xx status', async () => {
        const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL) => {
          const href = String(url)
          if (href.includes('verify-key')) return textResponse('valid')
          return textResponse('', { status: 502, statusText: 'Bad Gateway' })
        })

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.match(warnText(warnLog[0]!), /502 Bad Gateway/)
        assert.equal(fetchMock.mock.callCount(), 2)
      })

      it('validates a given key only once (memoized), reusing the verdict across calls', async () => {
        const fetchMock = mockAkismetFetch({ verifyKey: 'valid', commentCheck: 'false' })

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })

        const verifyKeyCalls = fetchMock.mock.calls.filter((call) =>
          String(call.arguments[0]).includes('verify-key')
        )
        const commentCheckCalls = fetchMock.mock.calls.filter((call) =>
          String(call.arguments[0]).includes('comment-check')
        )
        assert.equal(verifyKeyCalls.length, 1)
        assert.equal(commentCheckCalls.length, 3)
      })

      it('re-validates independently when the key value changes', async () => {
        const fetchMock = mockAkismetFetch({ verifyKey: 'valid', commentCheck: 'false' })

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'key-one' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'key-two' })

        const verifyKeyCalls = fetchMock.mock.calls.filter((call) =>
          String(call.arguments[0]).includes('verify-key')
        )
        assert.equal(verifyKeyCalls.length, 2)
      })
    })

    it('renders plain text as a paragraph and returns both content and render', async () => {
      const result = await commentsDefaultModule.render('hello world')
      assert.equal(result.content, 'hello world')
      assert.equal(result.render.trim(), '<p>hello world</p>')
    })

    it('syntax-highlights a fenced code block with a known language via highlight.js', async () => {
      const result = await commentsDefaultModule.render('```js\nconst x = 1\n```')
      assert.match(result.render, /<pre><code class="language-js">/)
      assert.match(result.render, /class="hljs-\w+"/)
      assert.equal(result.content, '```js\nconst x = 1\n```')
    })

    it('falls back to escaped, unhighlighted code for an unknown language', async () => {
      const result = await commentsDefaultModule.render('```notalanguage\n<b>x</b>\n```')
      assert.match(result.render, /<pre><code class="language-notalanguage">/)
      assert.ok(!result.render.includes('<b>x</b>'))
      assert.match(result.render, /&lt;b&gt;x&lt;\/b&gt;/)
    })

    it('falls back to escaped, unhighlighted code for a real grammar outside highlight.js/lib/common', async () => {
      // -> `fortran` is a real highlight.js grammar, just not one `lib/common` registers -- which is
      //    what makes this a different case from the unknown-language fallback above.
      const result = await commentsDefaultModule.render('```fortran\n<b>x</b>\n```')
      assert.match(result.render, /<pre><code class="language-fortran">/)
      assert.ok(!result.render.includes('<b>x</b>'))
      assert.match(result.render, /&lt;b&gt;x&lt;\/b&gt;/)
    })

    it('renders an emoji shortcode', async () => {
      const result = await commentsDefaultModule.render('nice :smile:')
      assert.ok(!result.render.includes(':smile:'))
      assert.match(result.render, /😄|😃|😊/)
    })

    it('renders a markdown link with linkify off-syntax and autolinks a bare URL (linkify: true)', async () => {
      const result = await commentsDefaultModule.render('[wiki](https://js.wiki)')
      assert.match(result.render, /<a href="https:\/\/js\.wiki">wiki<\/a>/)

      const autolinked = await commentsDefaultModule.render('see https://js.wiki for more')
      assert.match(autolinked.render, /<a href="https:\/\/js\.wiki">https:\/\/js\.wiki<\/a>/)
    })

    it('converts a single newline to <br> (breaks: true)', async () => {
      const result = await commentsDefaultModule.render('line one\nline two')
      assert.match(result.render, /line one<br\s*\/?>\s*line two/)
    })

    it('neuters an attempted <script> injection, storing raw content but never executing markup', async () => {
      const result = await commentsDefaultModule.render('<script>alert(1)</script>')
      assert.ok(!result.render.includes('<script'))
      assert.ok(!/<script[\s>]/i.test(result.render))
    })

    it('neuters an attempted <img onerror> injection', async () => {
      const result = await commentsDefaultModule.render('<img src=x onerror="alert(1)">')
      // -> `html: false` escapes the tag delimiters, so the literal word "onerror" may survive as
      //    paragraph text -- but with no `<img>` element left for a browser to attach it to.
      assert.ok(!/<img[\s>]/i.test(result.render))
    })

    describe('mentions', () => {
      const mentions = new Map([
        ['bob', 'Bob'],
        ['ann.lee', 'Ann.Lee']
      ])

      it('wraps a resolved handle in a comment-mention span carrying its stored handle', async () => {
        const result = await commentsDefaultModule.render('hi @bob, welcome', { mentions })
        assert.equal(
          result.render.trim(),
          '<p>hi <span class="comment-mention" data-handle="Bob">@Bob</span>, welcome</p>'
        )
      })

      it('matches case-insensitively and leaves trailing punctuation outside the mention', async () => {
        const result = await commentsDefaultModule.render('thanks @ANN.LEE.', { mentions })
        assert.equal(
          result.render.trim(),
          '<p>thanks <span class="comment-mention" data-handle="Ann.Lee">@Ann.Lee</span>.</p>'
        )
      })

      it('leaves an unresolved @handle literal', async () => {
        const result = await commentsDefaultModule.render('hi @carol', { mentions })
        assert.equal(result.render.trim(), '<p>hi @carol</p>')
      })

      it('does not match a longer handle that merely starts with a resolved one', async () => {
        const result = await commentsDefaultModule.render('hi @bobby', { mentions })
        assert.ok(!result.render.includes('comment-mention'))
      })

      it('renders no mention when no resolved set is supplied', async () => {
        const result = await commentsDefaultModule.render('hi @bob')
        assert.equal(result.render.trim(), '<p>hi @bob</p>')
      })

      it('leaves a mention inside an inline code span alone', async () => {
        const result = await commentsDefaultModule.render('run `@bob` now', { mentions })
        assert.equal(result.render.trim(), '<p>run <code>@bob</code> now</p>')
      })

      it('leaves a mention inside a fenced block alone', async () => {
        const result = await commentsDefaultModule.render('```\n@bob\n```', { mentions })
        assert.ok(!result.render.includes('comment-mention'))
        assert.match(result.render, /@bob/)
      })

      it('does not treat the @ in an email address as a mention', async () => {
        const result = await commentsDefaultModule.render('write to alice@bob.com', { mentions })
        assert.ok(!result.render.includes('comment-mention'))
      })

      it('does not resolve an escaped @', async () => {
        const result = await commentsDefaultModule.render('hi \\@bob', { mentions })
        assert.ok(!result.render.includes('comment-mention'))
      })

      it('resolves a mention inside emphasis', async () => {
        const result = await commentsDefaultModule.render('**@bob**', { mentions })
        assert.match(result.render, /<strong><span class="comment-mention"/)
      })

      it('strips every attribute other than class and data-handle from typed markup', async () => {
        const result = await commentsDefaultModule.render(
          '<span onclick="alert(1)" style="x" data-evil="1">@bob</span>',
          { mentions }
        )
        assert.ok(!/<span[^>]*onclick/.test(result.render))
        assert.ok(!/<span[^>]*style/.test(result.render))
        assert.ok(!/<span[^>]*data-evil/.test(result.render))
      })

      it('never emits an attribute beyond class and data-handle, whatever the handle holds', async () => {
        const hostile = new Map([['x', 'x" onclick="alert(1)']])
        const result = await commentsDefaultModule.render('@x', { mentions: hostile })
        const tag = result.render.match(/<span[^>]*>/)?.[0] ?? ''
        assert.match(tag, /^<span class="comment-mention" data-handle="[^"]*">$/)
      })
    })

    it('resolves via fs.access, matching the exact check models/storage.ts runs for storage.ts', async () => {
      // -> `serverPath` stands in for `CARDINAL.SERVERPATH`, which `hasImplementation()` joins the
      //    module-relative path onto.
      const serverPath = path.join(import.meta.dirname, '..', '..', '..')
      await assert.doesNotReject(
        fs.access(path.join(serverPath, 'modules/comments', 'default', 'comments.ts'))
      )
    })
  })

  describe('definition.yml', () => {
    it('parses and declares exactly the akismet and minDelay props', async () => {
      const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
      const parsed = load(raw) as Record<string, any>

      assert.equal(parsed.key, 'default')
      assert.equal(parsed.isAvailable, true)
      assert.equal(typeof parsed.title, 'string')
      assert.ok(parsed.title.length > 0)
      assert.equal(typeof parsed.description, 'string')
      assert.ok(parsed.description.length > 0)
      assert.equal(parsed.vendor, 'Cardinal.js')
      assert.equal(parsed.website, 'https://github.com/dylan-hart/wiki')

      const props = parseModuleProps(parsed.props ?? {})
      assert.deepEqual(Object.keys(props).sort(), ['akismet', 'minDelay'])

      assert.equal(props.akismet.type, 'string')
      assert.equal(props.akismet.sensitive, true)
      assert.equal(props.akismet.default, '')
      assert.equal(props.akismet.order, 1)

      assert.equal(props.minDelay.type, 'number')
      assert.equal(props.minDelay.default, 30)
      assert.equal(props.minDelay.order, 2)
    })

    it('has a comments.ts sibling, so hasImplementation() would report true', async () => {
      await assert.doesNotReject(fs.access(path.join(import.meta.dirname, 'comments.ts')))
    })
  })
})
