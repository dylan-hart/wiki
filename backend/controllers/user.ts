import { isValidUuid } from '../helpers/common.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import type { FastifyInstance } from 'fastify'

/**
 * An avatar changes whenever its owner uploads a new one, and the URL never carries a version — so it
 * is always revalidated, and the ETag turns that into an empty 304 rather than a re-download.
 */
const AVATAR_CACHE = 'private, no-cache'

/**
 * Public, like `_site` and `_icons`: avatars appear next to page authors and in user pickers, so a
 * reader who can see a page can see them. Only what a user chose to upload is served, under a URL
 * that has to be known — nothing here enumerates users.
 */
async function routes(app: FastifyInstance) {
  /**
   * `current` resolves to the logged in user, so a page showing its own avatar needs no user ID to
   * build the URL with.
   */
  app.get<{ Params: { userId: string } }>('/:userId/avatar', async (req, reply) => {
    let userId: string | null = null
    if (req.params.userId === 'current') {
      userId = req.session?.authenticated ? (req.session.user?.id ?? null) : null
    } else if (isValidUuid(req.params.userId)) {
      userId = req.params.userId
    }
    if (!userId) {
      return reply.notFound('User not found')
    }

    // -> The hash column alone answers a conditional request -- the common case, since AVATAR_CACHE
    //    revalidates every time -- without reading the blob.
    const hash = await CARDINAL.models.users.getAvatarHash(userId)
    if (!hash) {
      return reply.notFound('This user has no avatar')
    }

    // -> `notModifiedOrPrepare` also sends `nosniff`: the bytes came from a user, so the browser
    //    must take the type at its word
    if (notModifiedOrPrepare(req, reply, { etag: `"${hash}"`, cacheControl: AVATAR_CACHE })) {
      return reply
    }

    const avatar = await CARDINAL.models.users.getAvatar(userId)
    if (!avatar) {
      return reply.notFound('This user has no avatar')
    }

    return reply.type(avatar.mime).send(avatar.data)
  })
}

export default routes
