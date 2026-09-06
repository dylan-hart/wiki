/**
 * Wiki.js Native comment provider.
 *
 * This is a scaffold (Task 615, Feature 390): the module shape and its handler signatures are in
 * place. `render` (Task 623), `checkSpam` (Task 628) and `checkRateLimit` (Task 632) are fully
 * implemented; none of them touch the database — `models/comments.ts` (Feature 389) is expected to
 * look up whatever each handler needs (e.g. the author's last-comment timestamp for
 * `checkRateLimit`) and pass it in.
 *
 * Feature 389 (the comments data model) owns `models/comments.ts` and, once it lands, the
 * `CommentProviderModule` interface below should move there and this file should import it — the
 * same way `models/storage.ts` and `models/authentication.ts` already own the contracts for their
 * own module kinds.
 *
 * No database access, no Fastify route, no Drizzle import — `models/comments.ts` is expected to
 * dynamically import this file's default export the same way `models/storage.ts` loads
 * `modules/storage/<key>/storage.ts`. `checkSpam` does read the ambient `WIKI` global
 * (`WIKI.config.host`, `WIKI.logger`), same as `modules/authentication/local/authentication.ts`
 * reads it for `WIKI.models` — that global is available everywhere in the backend without importing
 * (see CLAUDE.md's "Backend patterns"); it's just never the database/Fastify/Drizzle layer this
 * module otherwise stays out of.
 */

import MarkdownIt from 'markdown-it'
import { full as markdownItEmoji } from 'markdown-it-emoji'
import hljs from 'highlight.js'
import sanitizeHtml from 'sanitize-html'
import { escape } from 'es-toolkit/string'
import { AkismetClient } from 'akismet-api'

/**
 * What a comment renders to: the raw markdown as submitted, and the sanitized HTML derived from it.
 * Mirrors the `content`/`render` column split Feature 389's `comments` table is expected to store —
 * both come back from a single call so the model never has to re-derive one from the other.
 */
export interface CommentRenderResult {
  /** The raw markdown exactly as submitted. Stored as-is; never itself re-rendered on read. */
  content: string
  /** Sanitized HTML, safe to write into the page without further escaping. */
  render: string
}

/**
 * The fields a spam check runs against, matching exactly what 2.5.x's
 * `server/modules/comments/default/comment.js#create()` passed to Akismet's `checkSpam()`.
 *
 * **Input contract**: this module has no request context, no session, and no access to `models/*`,
 * so every field here is the caller's responsibility to supply — nothing is inferred or looked up:
 *   - `ip` / `userAgent` come from the HTTP request that posted the comment.
 *   - `permalink` / `permalinkDate` come from the page the comment was posted to.
 *   - `role` must be computed by the *caller* from the poster's group memberships
 *     (`'administrator'` if they hold the admin group, `'guest'` if unauthenticated, `'user'`
 *     otherwise — see 2.5.x's own `create()` for the exact mapping). This module never sees a
 *     user's groups, so it cannot derive this itself.
 */
export interface CheckSpamParams {
  /** The commenter's IP address. Required by Akismet. */
  ip: string
  /** The commenter's user agent string. */
  userAgent: string
  /** The comment's raw (markdown) content. */
  content: string
  /** The commenter's display name. */
  name?: string
  /** The commenter's email address. */
  email?: string
  /** A permalink to the page the comment was posted on. */
  permalink?: string
  /** ISO 8601 timestamp of when that page was last modified. */
  permalinkDate?: string
  /** Akismet's `comment_type`. Always `'comment'` until this provider supports threaded replies. */
  type: 'comment' | 'reply'
  /** See the input-contract note above — this is the one field this module cannot compute itself. */
  role: 'administrator' | 'guest' | 'user'
}

/**
 * A spam verdict. `isSpam` is always present and is the only field a caller strictly needs to branch
 * on; `reason` is set whenever the verdict is a fail-open default (empty/invalid key, Akismet
 * unreachable) rather than an actual Akismet response, so the caller can log *why* spam-checking was
 * skipped without this module throwing over it.
 */
export interface SpamCheckResult {
  isSpam: boolean
  reason?: string
}

/**
 * The input `checkRateLimit` needs to decide whether the current poster may comment right now.
 *
 * **Input contract**: this module has no database access (per the architectural boundary described
 * in Feature 390 — it enforces the window, it does not look anything up), so `lastCommentAt` is
 * entirely the caller's responsibility to resolve, and it must already reflect **guest pooling**:
 * 2.5.x's own hint text for this prop is "all guests are considered as a single account", so an
 * unauthenticated poster is never its own bucket. The caller must look up a single, shared
 * last-comment timestamp for every guest combined — e.g. keyed by the guests group's ID rather than
 * by session or IP — before calling this, the same way it would look up one timestamp per real
 * account for an authenticated poster. This module has no concept of "guest" at all; it only ever
 * compares two instants it was handed.
 */
export interface CheckRateLimitParams {
  /**
   * The `Temporal.Instant` of the relevant account's most recent comment (the shared guest-bucket
   * timestamp for an unauthenticated poster, per the contract above), or `undefined`/`null` if that
   * account has never posted before — always allowed in that case.
   */
  lastCommentAt?: Temporal.Instant | null
}

/**
 * The contract every comment provider module implements, keyed by the module's own `definition.yml`
 * `props` (see `helpers/common.ts`'s `ModuleProp` for what a resolved prop looks like). Local copy
 * only, for now — see the file-level comment above.
 */
export interface CommentProviderModule {
  /**
   * Render raw comment content (as the author submitted it) to sanitized HTML for display.
   */
  render(content: string): Promise<CommentRenderResult>

  /**
   * Whether a comment looks like spam, checked against Akismet using the module's own configuration
   * (the `akismet` prop from `definition.yml`, read off `conf.akismet`). See `CheckSpamParams` for
   * the input contract. Never throws on a spam verdict, or on a misconfigured/unreachable Akismet —
   * "this is spam" is a normal outcome to branch on, and a bad key must degrade spam-checking, not
   * block comment submission.
   */
  checkSpam(params: CheckSpamParams, conf: Record<string, any>): Promise<SpamCheckResult>

  /**
   * Whether the poster is within the module's configured minimum delay between comments (the
   * `minDelay` prop). All guests are treated as a single account. See `CheckRateLimitParams` and
   * the standalone `checkRateLimit` function below for the full contract.
   */
  checkRateLimit(params: CheckRateLimitParams, conf: Record<string, any>): Promise<boolean>
}

/*
  A markdown-it instance scoped to comment content, wholly separate from `frontend/src/renderers/
  markdown.js` (that one drives the page editor and its preview, imports nothing this file can see,
  and is configured per-site out of `WIKI.sites`). This one is fixed and comment-only, matching how
  2.5.x's `server/modules/comments/default/comment.js` configured its own instance:

   - `html: false` — raw HTML in a comment is never allowed. This is the load-bearing setting: it is
     what makes a comment safe even without the `sanitize-html` pass below, since markdown-it escapes
     any `<script>` or `<img onerror=…>` an author types to inert text before it is ever HTML. The
     sanitizer is defense in depth on top of that, not the only thing standing in the way of it.
   - `breaks: true` — a single newline in a comment (as typed in a plain textarea, no blank line
     needed) becomes a `<br>`, matching how people actually type a short reply.
   - `linkify: true` — a bare URL becomes a link without the author having to write `[text](url)`.
*/
const commentMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight(str, lang) {
    /*
      `getLanguage` first: `hljs.highlight` throws on a language it does not recognize, and an
      unrecognized fence (or one whose info string is not really a language at all) falls back to
      escaped, unhighlighted code rather than taking the whole render down. Same pattern as the
      frontend's comparable renderer, minus the line-number/diagram handling a comment never needs.
    */
    const highlighted =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        : escape(str)
    return `<pre><code class="language-${escape(lang ?? '')}">${highlighted}</code></pre>`
  }
}).use(markdownItEmoji)

/**
 * Tags a comment's rendered HTML may use. A strict subset of `models/rendering.ts`'s
 * `BASE_ALLOWED_TAGS` (itself deliberately broad, for a page whose author may hold `write:scripts`/
 * `write:styles`): a comment author holds neither, has no block picker, and gets no images, media,
 * embeds, icons or raw SVG/MathML — just inline formatting, code blocks, lists and links, the same
 * ceiling 2.5.x's comment renderer had (`html: false`, no permission system of its own).
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

/** Attributes allowed on the tags above. Everything else that survives comes through bare. */
const COMMENT_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'rel'],
  // -> highlight.js puts `language-<x>` on the wrapping `<code>` and `hljs-<token>` on the `<span>`s
  //    inside it; without these two the syntax highlighting sanitizes back out to plain text
  code: ['class'],
  span: ['class']
}

/** Which URL schemes a comment's links may use. No `data:`: a comment carries no images to need it. */
const COMMENT_ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel']

/**
 * Turn raw comment markdown into the sanitized HTML that gets stored and displayed, matching 2.5.x's
 * `content`/`render` column split: the markdown is what gets stored as `content`, this HTML is what
 * gets stored as `render`.
 */
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

/**
 * Minimal surface of `akismet-api`'s `AkismetClient` this module actually calls. Exists purely as a
 * test seam: `akismet-api` builds its own `superagent` request inside the client with no way to
 * inject a transport, so `comments.test.ts` substitutes a fake implementing this shape (via
 * `_setAkismetClientFactoryForTesting`) instead of making a real network call to Akismet.
 */
interface AkismetClientLike {
  verifyKey(): Promise<boolean>
  checkSpam(comment: Record<string, string | boolean | undefined>): Promise<boolean>
}

type AkismetClientFactory = (opts: { key: string; blog: string }) => AkismetClientLike

let createAkismetClient: AkismetClientFactory = (opts) => new AkismetClient(opts)

/**
 * Test-only seam — substitutes the factory used to construct the Akismet client so
 * `comments.test.ts` can exercise the validate/warn/fail-open paths without hitting the real Akismet
 * service. Not part of the `CommentProviderModule` contract. Pass `null` to restore the real client.
 */
export function _setAkismetClientFactoryForTesting(factory: AkismetClientFactory | null): void {
  createAkismetClient = factory ?? ((opts) => new AkismetClient(opts))
}

/**
 * One entry per distinct (key, blog) pair this process has seen, resolving to the validated client
 * or `null` if the key was rejected or couldn't be verified. Memoized for the process lifetime rather
 * than re-verified on every comment — this is the "on module load, validate the configured key" part
 * of the contract, adapted to a per-call `conf` (this module has no separate init lifecycle hook, and
 * `conf` can differ per site): the first `checkSpam` call for a given key pays the verification cost,
 * every later call for that same key is a map lookup. Storing the pending promise (not just the
 * resolved value) also means two concurrent `checkSpam` calls for a brand-new key share one
 * `verifyKey()` request instead of firing two.
 */
const akismetClients = new Map<string, Promise<AkismetClientLike | null>>()

/** Clears the memoized-client cache. Test-only — a real process never needs to forget a validated key. */
export function _resetAkismetClientCacheForTesting(): void {
  akismetClients.clear()
}

/**
 * Resolve the validated Akismet client for `key`/`blog`, constructing and verifying it on first use.
 * Never rejects: a validation failure (an invalid key, or Akismet being unreachable) is logged as a
 * warning and cached as `null`, matching 2.5.x's `comment.js#init()` — "logged as warnings but don't
 * block submission" — so a mistyped or expired key disables the spam check, not comment posting.
 */
function getAkismetClient(key: string, blog: string): Promise<AkismetClientLike | null> {
  const cacheKey = `${key} ${blog}`
  let pending = akismetClients.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const client = createAkismetClient({ key, blog })
      try {
        const isValid = await client.verifyKey()
        if (!isValid) {
          WIKI.logger.warn('ext', 'akismet key rejected, spam checking disabled', {
            module: 'default'
          })
          return null
        }
        return client
      } catch (err: any) {
        WIKI.logger.warn('ext', 'verifying the akismet key failed', {
          module: 'default',
          error: err
        })
        return null
      }
    })()
    akismetClients.set(cacheKey, pending)
  }
  return pending
}

/**
 * Runs a `CheckSpamParams` comment through Akismet using the given module `conf`. See
 * `CommentProviderModule.checkSpam` and `CheckSpamParams` for the full contract.
 */
async function checkSpam(
  params: CheckSpamParams,
  conf: Record<string, any>
): Promise<SpamCheckResult> {
  const key = typeof conf?.akismet === 'string' ? conf.akismet.trim() : ''
  // -> Empty key: the configured no-op, per `definition.yml`'s "Leave empty to disable" hint. No
  //    client is constructed and no `WIKI.logger.warn` is emitted — this is not a failure, it is the
  //    documented way to turn spam checking off.
  if (!key) {
    return { isSpam: false }
  }

  const blog = WIKI.config?.host
  if (!blog) {
    WIKI.logger.warn('ext', 'no site host configured, akismet spam checking disabled', {
      module: 'default'
    })
    return { isSpam: false, reason: 'Akismet is not configured (missing site host).' }
  }

  const client = await getAkismetClient(key, blog)
  if (!client) {
    return { isSpam: false, reason: 'Akismet key is not valid, or could not be verified.' }
  }

  try {
    const isSpam = await client.checkSpam({
      ip: params.ip,
      useragent: params.userAgent,
      content: params.content,
      name: params.name,
      email: params.email,
      permalink: params.permalink,
      permalinkDate: params.permalinkDate,
      type: params.type,
      role: params.role
    })
    return { isSpam }
  } catch (err: any) {
    WIKI.logger.warn('ext', 'akismet spam check failed', { module: 'default', error: err })
    return { isSpam: false, reason: `Akismet check failed: ${err.message}` }
  }
}

/**
 * Pure decision: given the module's configured `minDelay` (seconds) and the timestamp of the
 * relevant account's most recent comment, is another comment allowed right now?
 *
 * Deliberately free of any I/O — no database, no session, no clock read beyond the instants it is
 * handed (`now` defaults to the real clock but is overridable, purely so tests don't need to install
 * a fake `Temporal`) — per the architectural boundary described in Feature 390: this module enforces
 * the window, it never decides who counts as one account or looks anything up itself. See
 * `CheckRateLimitParams` for the guest-pooling contract `lastCommentAt` must already satisfy.
 *
 * Follows CLAUDE.md's Temporal conventions exactly: instants are compared with
 * `Temporal.Instant.compare()` (`<` throws on Temporal types), and the cutoff is built with
 * `{ seconds: minDelay }` — an exact-time unit valid on `Instant.add`, unlike anything calendar-based.
 *
 * @param minDelay - Minimum seconds required between comments from the same account. `0` (or any
 *   non-positive/non-finite value) disables rate limiting entirely, matching this prop's "leave
 *   empty/zero to disable" pattern (`definition.yml`'s `minDelay` has no separate enable flag).
 * @param lastCommentAt - The account's most recent comment instant, or `undefined`/`null` if it has
 *   never posted before — always allowed in that case (there is nothing to be too soon after).
 * @param now - The instant to check against. Defaults to `Temporal.Now.instant()`.
 * @returns `true` if posting is currently allowed, `false` if the caller is still within the
 *   configured delay.
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
