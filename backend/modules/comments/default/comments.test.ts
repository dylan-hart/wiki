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

    it('has stubbed handlers that reject rather than silently no-op', async () => {
      await assert.rejects(commentsDefaultModule.render('hello'))
      await assert.rejects(commentsDefaultModule.checkSpam({ content: 'hi', author: 'x' }, {}))
      await assert.rejects(commentsDefaultModule.checkRateLimit({ userId: 1 }, {}))
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
