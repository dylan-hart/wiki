/**
 * No database, no Fastify route, no Drizzle import: every input is supplied by the caller, apart
 * from the ambient `CARDINAL.config.host`/`CARDINAL.logger` reads in `checkSpam`. That boundary is
 * what the `CheckSpamParams`/`CheckRateLimitParams` input contracts below exist to describe.
 *
 * `checkRateLimit` has no caller: the route layer rate-limits through
 * `CARDINAL.models.rateLimits.consume()` instead, because the pure compare here cannot persist
 * "last comment at" across requests or instances.
 */

import MarkdownIt from 'markdown-it'
import { full as markdownItEmoji } from 'markdown-it-emoji'
// -> `lib/common`, not the `highlight.js` root: the root registers every grammar the package ships,
//    and a comment's fenced content is untrusted input — grammars are a classic ReDoS surface, so a
//    smaller reachable set is a real risk reduction. It is also the set the page renderer uses, so
//    both highlight the same languages; a fence outside it renders unhighlighted.
import hljs from 'highlight.js/lib/common'
import sanitizeHtml from 'sanitize-html'
import { escape } from 'es-toolkit/string'

export interface CommentRenderResult {
  content: string
  render: string
}

/**
 * **Input contract**: this module has no request context, no session and no access to `models/*`,
 * so nothing here is inferred or looked up. `role` in particular must be derived by the caller from
 * the poster's group memberships — `'administrator'` if they hold the admin group, `'guest'` if
 * unauthenticated, `'user'` otherwise — since this module never sees a user's groups.
 */
export interface CheckSpamParams {
  ip: string
  userAgent: string
  content: string
  name?: string
  email?: string
  permalink?: string
  /** ISO 8601 timestamp of when that page was last modified, not of the comment. */
  permalinkDate?: string
  type: 'comment' | 'reply'
  role: 'administrator' | 'guest' | 'user'
}

/**
 * `reason` is set only when the verdict is a fail-open default (empty/invalid key, Akismet
 * unreachable) rather than an actual Akismet answer, so a caller can log why spam checking was
 * skipped instead of this module throwing over it.
 */
export interface SpamCheckResult {
  isSpam: boolean
  reason?: string
}

/**
 * **Input contract**: this module has no database access — it enforces the window, it looks nothing
 * up — so the caller resolves `lastCommentAt`, already reflecting **guest pooling**: all guests
 * count as a single account, so an unauthenticated poster is never its own bucket. Absent means
 * never posted, which is always allowed.
 */
export interface CheckRateLimitParams {
  lastCommentAt?: Temporal.Instant | null
}

export interface CommentProviderModule {
  render(content: string): Promise<CommentRenderResult>

  /**
   * Never throws, on a spam verdict or on a misconfigured/unreachable Akismet: "this is spam" is a
   * normal outcome to branch on, and a bad key must degrade spam checking rather than block comment
   * submission. `conf` carries the module's own `definition.yml` props.
   */
  checkSpam(params: CheckSpamParams, conf: Record<string, any>): Promise<SpamCheckResult>

  checkRateLimit(params: CheckRateLimitParams, conf: Record<string, any>): Promise<boolean>
}

/*
  `html: false` is the load-bearing setting: markdown-it escapes any `<script>` or `<img onerror=…>`
  an author types to inert text before it is ever HTML, so a comment is safe even without the
  `sanitize-html` pass below. That pass is defense in depth, not the only thing in the way.
*/
const commentMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight(str, lang) {
    /*
      `getLanguage` first: `hljs.highlight` throws on a language it does not recognize, so an
      unrecognized fence must fall back to escaped, unhighlighted code rather than take the whole
      render down.
    */
    const highlighted =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        : escape(str)
    return `<pre><code class="language-${escape(lang ?? '')}">${highlighted}</code></pre>`
  }
}).use(markdownItEmoji)

/**
 * Deliberately a strict subset of `models/rendering.ts`'s `BASE_ALLOWED_TAGS`, which is broad
 * because a page author may hold `write:scripts`/`write:styles`. A comment author holds neither and
 * gets no images, media, embeds, icons or raw SVG/MathML.
 */
const COMMENT_ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'mark',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6'
]

const COMMENT_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'rel'],
  // -> highlight.js puts `language-<x>` on the wrapping `<code>` and `hljs-<token>` on the `<span>`s
  //    inside it; without these two the syntax highlighting sanitizes back out to plain text
  code: ['class'],
  span: ['class']
}

/** No `data:` — a comment carries no images to need it. */
const COMMENT_ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel']

function renderComment(content: string): CommentRenderResult {
  const rendered = commentMarkdown.render(content)
  const clean = sanitizeHtml(rendered, {
    allowedTags: COMMENT_ALLOWED_TAGS,
    allowedAttributes: COMMENT_ALLOWED_ATTRIBUTES,
    allowedSchemes: COMMENT_ALLOWED_SCHEMES,
    // -> Applies only to tags that were dropped: without it, the body of a rejected `<script>` or
    //    `<style>` would come back out as visible page text instead of vanishing with the tag
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript']
  })
  return { content, render: clean }
}

const AKISMET_REQUEST_TIMEOUT_MS = 10000

/**
 * None of `models/liveData.ts`'s SSRF-pinning machinery: `url` is always one of Akismet's own fixed
 * hosts, never an author-supplied one.
 */
async function postAkismetForm(url: string, body: URLSearchParams): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // -> Akismet's docs ask every client to identify itself, e.g. "WordPress/4.6 | Akismet/3.1.9".
      'User-Agent': `Cardinal.js/${CARDINAL.version} | akismet-http-client`
    },
    body,
    signal: AbortSignal.timeout(AKISMET_REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`Akismet answered ${response.status} ${response.statusText}`)
  }
  return (await response.text()).trim()
}

async function verifyAkismetKey(key: string, blog: string): Promise<boolean> {
  const text = await postAkismetForm(
    'https://rest.akismet.com/1.1/verify-key',
    new URLSearchParams({ key, blog })
  )
  if (text === 'valid') {
    return true
  }
  if (text === 'invalid') {
    return false
  }
  throw new Error(text)
}

async function submitAkismetCommentCheck(
  key: string,
  blog: string,
  comment: CheckSpamParams
): Promise<boolean> {
  const body = new URLSearchParams({ blog })
  const set = (field: string, value: string | undefined) => {
    if (value !== undefined) {
      body.set(field, value)
    }
  }
  set('user_ip', comment.ip)
  set('user_agent', comment.userAgent)
  set('comment_content', comment.content)
  set('comment_author', comment.name)
  set('comment_author_email', comment.email)
  set('permalink', comment.permalink)
  set('comment_post_modified_gmt', comment.permalinkDate)
  set('comment_type', comment.type)
  set('user_role', comment.role)

  const text = await postAkismetForm(`https://${key}.rest.akismet.com/1.1/comment-check`, body)
  if (text === 'true') {
    return true
  }
  if (text === 'false') {
    return false
  }
  if (text === 'invalid') {
    throw new Error('Invalid API key')
  }
  throw new Error(text)
}

/**
 * Memoized for the process lifetime rather than re-verified per comment; there is no init lifecycle
 * hook to validate the key in, and `conf` can differ per site. Storing the pending promise, not the
 * resolved value, makes two concurrent first calls share one `verify-key` request.
 */
const akismetKeyValidity = new Map<string, Promise<boolean>>()

export function _resetAkismetKeyCacheForTesting(): void {
  akismetKeyValidity.clear()
}

/**
 * Never rejects: an invalid key, or an unreachable Akismet, is warned about and cached as `false`,
 * so a mistyped or expired key disables the spam check rather than comment posting.
 */
function isAkismetKeyValid(key: string, blog: string): Promise<boolean> {
  const cacheKey = `${key} ${blog}`
  let pending = akismetKeyValidity.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      try {
        const isValid = await verifyAkismetKey(key, blog)
        if (!isValid) {
          CARDINAL.logger.warn('ext', 'akismet key rejected, spam checking disabled', {
            module: 'default'
          })
        }
        return isValid
      } catch (err: any) {
        CARDINAL.logger.warn('ext', 'verifying the akismet key failed', {
          module: 'default',
          error: err
        })
        return false
      }
    })()
    akismetKeyValidity.set(cacheKey, pending)
  }
  return pending
}

async function checkSpam(
  params: CheckSpamParams,
  conf: Record<string, any>
): Promise<SpamCheckResult> {
  const key = typeof conf?.akismet === 'string' ? conf.akismet.trim() : ''
  // -> Empty key is the configured no-op (`definition.yml`: "Leave empty to disable"), so unlike
  //    the branches below it stays silent rather than warning about a failure.
  if (!key) {
    return { isSpam: false }
  }

  const blog = CARDINAL.config?.host
  if (!blog) {
    CARDINAL.logger.warn('ext', 'no site host configured, akismet spam checking disabled', {
      module: 'default'
    })
    return { isSpam: false, reason: 'Akismet is not configured (missing site host).' }
  }

  const isValid = await isAkismetKeyValid(key, blog)
  if (!isValid) {
    return { isSpam: false, reason: 'Akismet key is not valid, or could not be verified.' }
  }

  try {
    const isSpam = await submitAkismetCommentCheck(key, blog, params)
    return { isSpam }
  } catch (err: any) {
    CARDINAL.logger.warn('ext', 'akismet spam check failed', { module: 'default', error: err })
    return { isSpam: false, reason: `Akismet check failed: ${err.message}` }
  }
}

/**
 * `minDelay` is in seconds, and `0` or any non-positive value disables rate limiting outright —
 * `definition.yml`'s `minDelay` has no separate enable flag. `Temporal.Instant.compare()` rather
 * than `<`, which throws on Temporal types, and `{ seconds }` rather than a calendar unit, which
 * `Instant.add` rejects on an exact-time type.
 */
export function checkRateLimit(
  minDelay: number,
  lastCommentAt: Temporal.Instant | null | undefined,
  now: Temporal.Instant = Temporal.Now.instant()
): boolean {
  if (!(minDelay > 0)) {
    return true
  }
  if (!lastCommentAt) {
    return true
  }
  const cutoff = lastCommentAt.add({ seconds: minDelay })
  return Temporal.Instant.compare(now, cutoff) >= 0
}

const commentsDefaultModule: CommentProviderModule = {
  async render(content) {
    return renderComment(content)
  },
  async checkSpam(params, conf) {
    return checkSpam(params, conf)
  },
  async checkRateLimit(params, conf) {
    const minDelay = typeof conf?.minDelay === 'number' ? conf.minDelay : 0
    return checkRateLimit(minDelay, params.lastCommentAt)
  }
}

export default commentsDefaultModule
