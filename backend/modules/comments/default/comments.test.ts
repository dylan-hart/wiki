import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/common.ts'
import commentsDefaultModule from './comments.ts'

describe('modules/comments/default', () => {
  describe('comments.ts', () => {
    it('is importable and exposes the CommentProviderModule contract', () => {
      assert.equal(typeof commentsDefaultModule.render, 'function')
      assert.equal(typeof commentsDefaultModule.checkSpam, 'function')
      assert.equal(typeof commentsDefaultModule.checkRateLimit, 'function')
    })

    it('has stubbed handlers (checkSpam, checkRateLimit) that reject rather than silently no-op', async () => {
      await assert.rejects(commentsDefaultModule.checkSpam({ content: 'hi', author: 'x' }, {}))
      await assert.rejects(commentsDefaultModule.checkRateLimit({ userId: 1 }, {}))
    })

    it('renders plain text as a paragraph and returns both content and render', async () => {
      const result = await commentsDefaultModule.render('hello world')
      assert.equal(result.content, 'hello world')
      assert.equal(result.render.trim(), '<p>hello world</p>')
    })

    it('syntax-highlights a fenced code block with a known language via highlight.js', async () => {
      const result = await commentsDefaultModule.render('```js\nconst x = 1\n```')
      assert.match(result.render, /<pre><code class="language-js">/)
      // -> highlight.js wraps recognized tokens (`const`, here) in spans with hljs-* classes
      assert.match(result.render, /class="hljs-\w+"/)
      assert.equal(result.content, '```js\nconst x = 1\n```')
    })

    it('falls back to escaped, unhighlighted code for an unknown language', async () => {
      const result = await commentsDefaultModule.render('```notalanguage\n<b>x</b>\n```')
      assert.match(result.render, /<pre><code class="language-notalanguage">/)
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
      // -> `html: false` escapes the tag delimiters, so what remains is inert paragraph TEXT — the
      //    literal word "onerror" may still be visible on the page, but there is no real `<img>`
      //    element left for a browser to attach it to as an executing attribute.
      assert.ok(!/<img[\s>]/i.test(result.render))
    })

    it('resolves via fs.access, matching the exact check models/storage.ts runs for storage.ts', async () => {
      // -> models/storage.ts's hasImplementation() runs:
      //      fs.access(path.join(WIKI.SERVERPATH, 'modules/storage', key, 'storage.ts'))
      //    which resolves to <repo-root>/backend/modules/storage/<key>/storage.ts. Once
      //    models/comments.ts exists it is expected to run the same check against
      //    'modules/comments'; this asserts the equivalent path for this module resolves today.
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
      assert.equal(parsed.vendor, 'Wiki.js')
      assert.equal(parsed.website, 'https://js.wiki')

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
