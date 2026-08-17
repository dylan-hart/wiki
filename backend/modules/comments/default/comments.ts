/**
 * Wiki.js Native comment provider.
 *
 * This is a scaffold (Task 615, Feature 390): the module shape and its handler signatures are in
 * place; `checkSpam` and `checkRateLimit` are still stubbed to throw (they need the Akismet client
 * and, respectively, the comments table, neither of which exists yet). `render` (Task 623) is fully
 * implemented — it needs nothing beyond a markdown string.
 *
 * Feature 389 (the comments data model) owns `models/comments.ts` and, once it lands, the
 * `CommentProviderModule` interface below should move there and this file should import it — the
 * same way `models/storage.ts` and `models/authentication.ts` already own the contracts for their
 * own module kinds.
 *
 * Pure module: no database access, no Fastify route, no Drizzle import. `models/comments.ts` is
 * expected to dynamically import this file's default export the same way `models/storage.ts` loads
 * `modules/storage/<key>/storage.ts`.
 */

import MarkdownIt from 'markdown-it'
import { full as markdownItEmoji } from 'markdown-it-emoji'
import hljs from 'highlight.js'
import sanitizeHtml from 'sanitize-html'
import { escape } from 'es-toolkit/string'

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
   * Whether a comment looks like spam, given the module's own configuration (e.g. an Akismet API
   * key set via the `akismet` prop).
   */
  checkSpam(
    params: { content: string; author: string; email?: string; ip?: string; userAgent?: string },
    conf: Record<string, any>
  ): Promise<boolean>

  /**
   * Whether the poster is within the module's configured minimum delay between comments (the
   * `minDelay` prop). All guests are treated as a single account.
   */
  checkRateLimit(params: { userId: number }, conf: Record<string, any>): Promise<boolean>
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

const commentsDefaultModule: CommentProviderModule = {
  async render(content) {
    return renderComment(content)
  },
  async checkSpam(_params, _conf) {
    throw new Error('Not implemented')
  },
  async checkRateLimit(_params, _conf) {
    throw new Error('Not implemented')
  }
}

export default commentsDefaultModule
