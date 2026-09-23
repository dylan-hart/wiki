import type { FastifyInstance } from 'fastify'
import { CustomError, normalizePagePath } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import { notesEnabled } from '../helpers/notes.ts'
import { promoteNote } from '../helpers/notePromotion.ts'
import { actorFrom, mayOnAsset, mayOnPage } from '../helpers/pageAccess.ts'

interface NotePromoteBody {
  path: string
  title: string
  locale?: string
  render?: string
  noteUpdatedAt?: string
}

async function routes(app: FastifyInstance) {
  app.post<{ Params: { siteId: string; noteId: string }; Body: NotePromoteBody }>(
    '/sites/:siteId/notes/:noteId/promote',
    {
      schema: {
        summary: 'Promote a note to a wiki page',
        description:
          "Creates a page from one of the caller's own notes, moves the images it shows into the new page's folder as assets, points the page at them, and deletes the note, all or nothing: a refusal or a failure at any step leaves the note and its images exactly as they were. The page is created the way `POST /sites/:siteId/pages` creates one, with the same reserved-path, locale and duplicate-path (`pageDuplicatePath`, 409) checks, as a `wysiwyg` page.\n\nThe caller needs `write:pages` at the destination, and `write:assets` in its folder when the note has images to move. The page is published when the caller also holds `publish:pages` there, and saved as a draft otherwise. Another user's note answers 404 as though it did not exist.",
        tags: ['Notes'],
        params: { $ref: 'NotePromoteParams#' },
        body: { $ref: 'NotePromoteInput#' },
        response: {
          200: {
            description: 'The note is now a page',
            $ref: 'NotePromoteResult#'
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: {
            $ref: 'ApiError#',
            description:
              'Notes are turned off on this site (`notesDisabled`), or the caller may not create the page or upload its images there.'
          },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description:
              'A page already exists at the destination (`pageDuplicatePath`), or the note was saved after `render` was made from it (`noteChanged`).'
          }
        }
      }
    },
    async (req, reply) => {
      const { siteId, noteId } = req.params
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Promoting a note requires a logged in user.')
      }
      if (!notesEnabled(siteId)) {
        throw new CustomError('notesDisabled', 'Notes are turned off on this site.', 403)
      }

      const locale = req.body.locale ?? defaultLocale(siteId)
      const destination = { path: normalizePagePath(req.body.path), locale }
      if (!mayOnPage(req, 'write:pages', siteId, destination)) {
        return reply.forbidden('You are not allowed to create a page here.')
      }
      const publishState = mayOnPage(req, 'publish:pages', siteId, destination)
        ? 'published'
        : 'draft'

      const result = await promoteNote({
        siteId,
        noteId,
        actor,
        path: req.body.path,
        title: req.body.title,
        locale,
        publishState,
        render: req.body.render,
        noteUpdatedAt: req.body.noteUpdatedAt,
        mayUploadTo: (folderPath, fileName) =>
          mayOnAsset(req, 'write:assets', siteId, { folderPath, fileName, locale })
      })
      if (!result) {
        return reply.notFound('This note does not exist.')
      }
      return { ok: true, ...result }
    }
  )
}

export default routes
