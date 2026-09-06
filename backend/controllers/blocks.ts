import crypto from 'node:crypto'
import { isValidUuid } from '../helpers/common.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import type { FastifyInstance } from 'fastify'

/**
 * A custom block has no in-place update path — editing one means delete-and-reupload, which mints a
 * new id (`models/blocks.ts`'s `createCustomBlock`/`deleteCustomBlock`) — so the bytes behind a given
 * id never change while that id is still valid. Safe to cache as hard as HTTP allows, the same way
 * `_thumb` and `_icons` do for the same reason.
 */
const CUSTOM_BLOCK_CACHE = 'public, max-age=31536000, immutable'

/**
 * _blocks/custom Routes
 *
 * `/_blocks/` itself is a `fastifyStatic` mount rooted at `blocks/compiled` (`index.ts`) — the build
 * output of the `blocks/` workspace, not a place runtime-uploaded code can be written safely or
 * durably. A custom block's code lives in the `blockCode` table instead, one row per block
 * (`models/blocks.ts`), and this is what streams it back out to whatever imports it — registered
 * under the same `/_blocks/custom` prefix so the runtime loader in `stores/common.js` can tell a
 * custom block's import from a built-in's apart by the URL shape alone.
 *
 * Public, like `_site`/`_icons`/`_thumb`: this is executable code a page's own reader is about to run
 * in their browser regardless, the same way a built-in block's compiled file already is served with no
 * check at all — gating the route would not protect anything a reader with the page open cannot
 * already reach.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; fileName: string } }>(
    '/:siteId/:fileName',
    async (req, reply) => {
      // -> `.js` is part of the URL so a `<script type="module">` import resolves it as one; the id is
      //    the only part that identifies anything, the same way `_thumb` treats `.webp`
      const blockId = req.params.fileName.replace(/\.js$/i, '')
      if (!isValidUuid(req.params.siteId) || !isValidUuid(blockId)) {
        return reply.notFound('Custom block not found')
      }

      const code = await WIKI.models.blocks.getCustomBlockCode(req.params.siteId, blockId)
      if (!code) {
        return reply.notFound('Custom block not found')
      }

      // -> `notModifiedOrPrepare` also sends `X-Content-Type-Options: nosniff`: the bytes were
      //    uploaded, not authored here — served as script only because that is the point of the
      //    route, not because a browser should go looking for another interpretation
      const etag = `"${crypto.createHash('sha1').update(code).digest('hex')}"`
      if (notModifiedOrPrepare(req, reply, { etag, cacheControl: CUSTOM_BLOCK_CACHE })) {
        return reply
      }

      return reply.type('application/javascript; charset=utf-8').send(code)
    }
  )
}

export default routes
