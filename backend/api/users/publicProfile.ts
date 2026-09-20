import type { FastifyInstance } from 'fastify'

async function routes(app: FastifyInstance) {
  app.get<{ Params: { userId: string } }>(
    '/:userId/profile',
    {
      schema: {
        summary: "Get another user's public profile",
        description:
          'Only what that user has chosen to show, plus whatever an administrator forces public: the name, the avatar, and the About Me fields that are both public and filled in. Never the email. Signed-in users only, unless an administrator lets guests view profiles. Inactive and system accounts are refused.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' }
          },
          required: ['userId']
        },
        response: {
          200: {
            description: 'The public profile',
            $ref: 'UserPublicProfile#'
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const signedIn = Boolean(req.session?.authenticated && req.session.user?.id) || !!req.apiKey
      if (!signedIn && CARDINAL.config.profileVisibility?.guestsMayView !== true) {
        return reply.unauthorized()
      }

      const profile = await CARDINAL.models.users.getPublicProfile(req.params.userId)
      if (!profile) {
        return reply.notFound('This user does not exist.')
      }
      return profile
    }
  )
}

export default routes
