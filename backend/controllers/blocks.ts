import crypto from 'node:crypto'
import { isValidUuid } from '../helpers/common.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import type { FastifyInstance } from 'fastify'

/**
 * A custom block has no in-place update path — editing one means delete-and-reupload, which mints a
 * new id — so the bytes behind an id never change and can be cached as hard as HTTP allows.
 */
const CUSTOM_BLOCK_CACHE = 'public, max-age=31536000, immutable'

/**
 * `/_blocks/` itself is a static mount of the `blocks/` workspace's build output, not a place
 * runtime-uploaded code can be written safely or durably, so a custom block's code lives in the
 * `blockCode` table and is streamed from here.
 *
 * Public: this is code a page's reader is about to run in their browser regardless, and a built-in
 * block's compiled file is served with no check either.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; fileName: string } }>(
    '/:siteId/:fileName',
    async (req, reply) => {
      const blockId = req.params.fileName.replace(/\.js$/i, '')
      if (!isValidUuid(req.params.siteId) || !isValidUuid(blockId)) {
        return reply.notFound('Custom block not found')
      }

      const code = await CARDINAL.models.blocks.getCustomBlockCode(req.params.siteId, blockId)
      if (!code) {
        return reply.notFound('Custom block not found')
      }

      // -> `notModifiedOrPrepare` also sends `nosniff`: these bytes were uploaded, not authored here
      const etag = `"${crypto.createHash('sha1').update(code).digest('hex')}"`
      if (notModifiedOrPrepare(req, reply, { etag, cacheControl: CUSTOM_BLOCK_CACHE })) {
        return reply
      }

      return reply.type('application/javascript; charset=utf-8').send(code)
    }
  )
}

export default routes
