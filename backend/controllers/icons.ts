import { generateHash } from '../helpers/common.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const MAX_ICONS_PER_REQUEST = 128

/** An icon never changes under a given name, so the answer can be cached as hard as HTTP allows. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** Long enough that a page's icons are asked for once, short enough to pick up new sets. */
const BATCH_CACHE = 'public, max-age=604800'

/** A batch that came back incomplete is worth asking about again soon. */
const INCOMPLETE_CACHE = 'public, max-age=60'

/**
 * Hashes the body for an ETag, since nothing here has an id or mtime to build one from.
 * `nosniff: false`: the batch JSON is built here, not uploaded, and the SVG route sets the header
 * itself.
 */
function sendCacheable(
  req: FastifyRequest,
  reply: FastifyReply,
  body: string,
  { contentType, cacheControl }: { contentType: string; cacheControl: string }
): FastifyReply {
  const etag = `"${generateHash(body)}"`
  if (notModifiedOrPrepare(req, reply, { etag, cacheControl, nosniff: false })) {
    return reply
  }
  return reply.type(contentType).send(body)
}

/**
 * Implements the part of the Iconify API protocol the frontend uses, so that `iconify-icon` can be
 * pointed at this wiki instead of a third-party host, and nothing about which icons a reader looks at
 * leaves the instance.
 *
 * Public on purpose — icons are page furniture. The routes only serve what the wiki holds or can fill
 * in for an enabled set, and filling is bounded by the model's upstream budget.
 */
async function routes(app: FastifyInstance) {
  /** What `iconify-icon` requests, one call per set per page */
  app.get<{ Params: { prefix: string }; Querystring: { icons?: string } }>(
    '/:prefix.json',
    async (req, reply) => {
      const prefix = req.params.prefix.toLowerCase()
      const names = (req.query.icons ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_ICONS_PER_REQUEST)
      if (names.length < 1) {
        return reply.badRequest('No icons requested.')
      }

      const set = await CARDINAL.models.icons.getSet(prefix)
      if (!set) {
        return reply.notFound('Icon set not found.')
      }

      const resolved = await CARDINAL.models.icons.resolveIcons(prefix, names)
      const payload = {
        prefix,
        icons: resolved.icons,
        ...(resolved.notFound.length > 0 && { not_found: resolved.notFound })
      }

      return sendCacheable(req, reply, JSON.stringify(payload), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: resolved.notFound.length > 0 ? INCOMPLETE_CACHE : BATCH_CACHE
      })
    }
  )

  /** For `<img>` and CSS, where a URL is all that fits */
  app.get<{ Params: { prefix: string; name: string } }>(
    '/:prefix/:name.svg',
    async (req, reply) => {
      const svg = await CARDINAL.models.icons.getIconSvg(
        req.params.prefix.toLowerCase(),
        req.params.name.toLowerCase()
      )
      if (!svg) {
        return reply.notFound('Icon not found.')
      }

      // -> The markup comes from a third party and is served from our own origin, so it is locked down
      //    for the case where it is opened as a document rather than drawn as an image
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      reply.header('X-Content-Type-Options', 'nosniff')

      return sendCacheable(req, reply, svg, {
        contentType: 'image/svg+xml; charset=utf-8',
        cacheControl: IMMUTABLE_CACHE
      })
    }
  )
}

export default routes
