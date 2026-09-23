import fastifyMultipart from '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CustomError } from '../helpers/common.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { detectImageMime } from '../helpers/images.ts'
import { assertNoteContentWithinCap, NOTE_MAX_TITLE_LENGTH } from '../helpers/noteContent.ts'
import { notesEnabled } from '../helpers/notes.ts'
import { NOTE_SEARCH_MAX_LIMIT, searchNotes } from '../helpers/notesSearch.ts'
import { requireActorId } from '../helpers/pageAccess.ts'

const NOTES_REQUIRED = 'Notes require a logged in user.'
const NOTES_DISABLED = 'Notes are turned off on this site.'
const NOTE_MISSING = 'This note does not exist.'
const SECTION_MISSING = 'This section does not exist.'
const IMAGE_MISSING = 'This image does not exist.'
const IMAGE_CACHE_CONTROL = 'private, max-age=86400'

const uuid = { type: 'string', format: 'uuid' } as const

const NOTE_ERRORS = {
  401: { $ref: 'ApiError#' },
  403: { $ref: 'ApiError#' },
  404: { $ref: 'ApiError#' }
} as const

const sectionParams = {
  type: 'object',
  properties: { siteId: uuid, sectionId: uuid },
  required: ['siteId', 'sectionId']
} as const

const noteParams = {
  type: 'object',
  properties: { siteId: uuid, noteId: uuid },
  required: ['siteId', 'noteId']
} as const

const imageParams = {
  type: 'object',
  properties: { siteId: uuid, noteId: uuid, imageId: uuid },
  required: ['siteId', 'noteId', 'imageId']
} as const

const idList = {
  type: 'array',
  items: uuid,
  uniqueItems: true,
  maxItems: 10000
} as const

const okResponse = {
  description: 'Done',
  type: 'object',
  properties: { ok: { type: 'boolean' } }
} as const

type SiteParams = { siteId: string }
type SectionParams = SiteParams & { sectionId: string }
type NoteParams = SiteParams & { noteId: string }
type ImageParams = NoteParams & { imageId: string }

export function noteImageUrl(siteId: string, noteId: string, imageId: string): string {
  return `/_api/sites/${siteId}/notes/${noteId}/images/${imageId}`
}

async function notesCaller(
  req: FastifyRequest<{ Params: SiteParams }>,
  reply: FastifyReply
): Promise<string | null> {
  const userId = requireActorId(req, reply, NOTES_REQUIRED)
  if (!userId) {
    return null
  }
  if (!notesEnabled(req.params.siteId)) {
    throw new CustomError('notesDisabled', NOTES_DISABLED, 403)
  }
  return userId
}

function normalizeTitle(title: string | null | undefined): string | null | undefined {
  if (title === undefined || title === null) {
    return title
  }
  const trimmed = title.trim()
  return trimmed ? trimmed : null
}

function requiredSectionTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) {
    throw new CustomError('Bad Request', 'A section needs a title.', 400)
  }
  return trimmed
}

async function ownsSection(siteId: string, userId: string, sectionId: string): Promise<boolean> {
  const sections = await CARDINAL.models.notes.listSections(siteId, userId)
  return sections.some((s) => s.id === sectionId)
}

function safeImageFileName(name: string | undefined, mimeType: string): string {
  const base = [...((name ?? '').split(/[\\/]/).pop() ?? '')]
    .filter((c) => c !== '"' && c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 255)
  return base || `image.${mimeType.split('/')[1]}`
}

async function routes(app: FastifyInstance) {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: CARDINAL.config.security?.uploadMaxFileSize ?? 10485760,
      files: 1
    }
  })

  // No route-level permissions: notes belong to their owner alone, so no global, page or site
  // permission applies. `notesCaller` requires a signed-in user and the site's `features.notes`,
  // and every model call is filtered on (siteId, userId), so another user's row answers 404.
  app.get<{ Params: SiteParams }>(
    '/sites/:siteId/notes/sections',
    {
      schema: {
        summary: "List the caller's note sections",
        description: "Only the caller's own sections on this site, in their order.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'The sections',
            type: 'object',
            properties: { sections: { type: 'array', items: { $ref: 'NoteSection#' } } }
          },
          401: NOTE_ERRORS[401],
          403: NOTE_ERRORS[403]
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      return { sections: await CARDINAL.models.notes.listSections(req.params.siteId, userId) }
    }
  )

  app.post<{ Params: SiteParams; Body: { title: string } }>(
    '/sites/:siteId/notes/sections',
    {
      schema: {
        summary: 'Add a note section',
        description: "Adds a section at the end of the caller's sections.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: { title: { type: 'string', maxLength: NOTE_MAX_TITLE_LENGTH } }
        },
        response: {
          200: { description: 'The new section', $ref: 'NoteSection#' },
          400: { $ref: 'ApiError#' },
          401: NOTE_ERRORS[401],
          403: NOTE_ERRORS[403]
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      return CARDINAL.models.notes.createSection(req.params.siteId, userId, {
        title: requiredSectionTitle(req.body.title)
      })
    }
  )

  app.put<{ Params: SiteParams; Body: { ids: string[] } }>(
    '/sites/:siteId/notes/sections/order',
    {
      schema: {
        summary: 'Reorder note sections',
        description:
          "Puts the caller's sections in the order given. A section id that is not the caller's answers 404 and nothing is reordered.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: idList }
        },
        response: { 200: okResponse, ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId } = req.params
      // Checked here, not left to the model, so that one foreign id rejects the whole reorder
      // with 404 before anything is written.
      const owned = new Set(
        (await CARDINAL.models.notes.listSections(siteId, userId)).map((s) => s.id)
      )
      if (!req.body.ids.every((id) => owned.has(id))) {
        return reply.notFound(SECTION_MISSING)
      }
      if (!(await CARDINAL.models.notes.reorderSections(siteId, userId, req.body.ids))) {
        return reply.notFound(SECTION_MISSING)
      }
      return { ok: true }
    }
  )

  app.put<{ Params: SectionParams; Body: { title: string } }>(
    '/sites/:siteId/notes/sections/:sectionId',
    {
      schema: {
        summary: 'Rename a note section',
        tags: ['Notes'],
        params: sectionParams,
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: { title: { type: 'string', maxLength: NOTE_MAX_TITLE_LENGTH } }
        },
        response: {
          200: { description: 'The renamed section', $ref: 'NoteSection#' },
          400: { $ref: 'ApiError#' },
          ...NOTE_ERRORS
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const section = await CARDINAL.models.notes.updateSection(
        req.params.siteId,
        userId,
        req.params.sectionId,
        { title: requiredSectionTitle(req.body.title) }
      )
      if (!section) {
        return reply.notFound(SECTION_MISSING)
      }
      return section
    }
  )

  app.delete<{ Params: SectionParams }>(
    '/sites/:siteId/notes/sections/:sectionId',
    {
      schema: {
        summary: 'Delete a note section',
        description: 'Deletes the section together with every note in it and their images.',
        tags: ['Notes'],
        params: sectionParams,
        response: { 200: okResponse, ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      if (
        !(await CARDINAL.models.notes.deleteSection(
          req.params.siteId,
          userId,
          req.params.sectionId
        ))
      ) {
        return reply.notFound(SECTION_MISSING)
      }
      return { ok: true }
    }
  )

  app.get<{ Params: SiteParams; Querystring: { q?: string; limit?: number } }>(
    '/sites/:siteId/notes/search',
    {
      schema: {
        summary: "Search the caller's notes",
        description:
          "Full-text search over the titles and content of the caller's own notes on this site, matching partial words too. Nobody else's notes are searched, and notes never appear in the site search.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 255 },
            limit: { type: 'integer', minimum: 1, maximum: NOTE_SEARCH_MAX_LIMIT }
          }
        },
        response: {
          200: { description: 'Matching notes', $ref: 'NoteSearchResults#' },
          401: NOTE_ERRORS[401],
          403: NOTE_ERRORS[403]
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const rows = await searchNotes({
        siteId: req.params.siteId,
        userId,
        query: req.query.q ?? '',
        limit: req.query.limit
      })
      return { results: rows }
    }
  )

  app.put<{ Params: SiteParams; Body: { sectionId: string; ids: string[] } }>(
    '/sites/:siteId/notes/order',
    {
      schema: {
        summary: 'Reorder the notes in a section',
        description:
          "Puts the notes of one of the caller's sections in the order given. A section or note id that is not the caller's, or a note from another section, answers 404 and nothing is reordered.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['sectionId', 'ids'],
          additionalProperties: false,
          properties: { sectionId: uuid, ids: idList }
        },
        response: { 200: okResponse, ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId } = req.params
      const { sectionId, ids } = req.body
      if (!(await ownsSection(siteId, userId, sectionId))) {
        return reply.notFound(SECTION_MISSING)
      }
      // Checked here, not left to the model, so that one foreign id rejects the whole reorder
      // with 404 before anything is written.
      const inSection = new Set(
        ((await CARDINAL.models.notes.listNotes(siteId, userId, sectionId)) ?? []).map((n) => n.id)
      )
      if (!ids.every((id) => inSection.has(id))) {
        return reply.notFound(NOTE_MISSING)
      }
      if (!(await CARDINAL.models.notes.reorderNotes(siteId, userId, sectionId, ids))) {
        return reply.notFound(NOTE_MISSING)
      }
      return { ok: true }
    }
  )

  app.get<{ Params: SiteParams; Querystring: { sectionId: string } }>(
    '/sites/:siteId/notes',
    {
      schema: {
        summary: 'List the notes in a section',
        description:
          'Without their content: each carries an `excerpt` to show for an untitled note.',
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          required: ['sectionId'],
          properties: { sectionId: uuid }
        },
        response: {
          200: {
            description: 'The notes, in their order',
            type: 'object',
            properties: { notes: { type: 'array', items: { $ref: 'NoteSummary#' } } }
          },
          ...NOTE_ERRORS
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId } = req.params
      if (!(await ownsSection(siteId, userId, req.query.sectionId))) {
        return reply.notFound(SECTION_MISSING)
      }
      const notes = await CARDINAL.models.notes.listNotes(siteId, userId, req.query.sectionId)
      if (!notes) {
        return reply.notFound(SECTION_MISSING)
      }
      return { notes }
    }
  )

  app.post<{
    Params: SiteParams
    Body: { sectionId: string; title?: string | null; content?: string }
  }>(
    '/sites/:siteId/notes',
    {
      schema: {
        summary: 'Add a note',
        description:
          "Adds a note at the end of one of the caller's sections. The title is optional; an empty one is stored as none.",
        tags: ['Notes'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['sectionId'],
          additionalProperties: false,
          properties: {
            sectionId: uuid,
            title: { type: ['string', 'null'], maxLength: NOTE_MAX_TITLE_LENGTH },
            content: { type: 'string' }
          }
        },
        response: {
          200: { description: 'The new note', $ref: 'Note#' },
          400: { $ref: 'ApiError#' },
          413: { $ref: 'ApiError#' },
          ...NOTE_ERRORS
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId } = req.params
      const { sectionId, content } = req.body
      if (content !== undefined) {
        assertNoteContentWithinCap(content)
      }
      if (!(await ownsSection(siteId, userId, sectionId))) {
        return reply.notFound(SECTION_MISSING)
      }
      const note = await CARDINAL.models.notes.createNote(siteId, userId, {
        sectionId,
        title: normalizeTitle(req.body.title),
        content
      })
      if (!note) {
        return reply.notFound(SECTION_MISSING)
      }
      return note
    }
  )

  app.get<{ Params: NoteParams }>(
    '/sites/:siteId/notes/:noteId',
    {
      schema: {
        summary: 'Get a note',
        description: 'With its content.',
        tags: ['Notes'],
        params: noteParams,
        response: { 200: { description: 'The note', $ref: 'Note#' }, ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const note = await CARDINAL.models.notes.getNote(req.params.siteId, userId, req.params.noteId)
      if (!note) {
        return reply.notFound(NOTE_MISSING)
      }
      return note
    }
  )

  app.put<{
    Params: NoteParams
    Body: { title?: string | null; content?: string; sectionId?: string }
  }>(
    '/sites/:siteId/notes/:noteId',
    {
      schema: {
        summary: 'Update a note',
        description:
          "Saves whichever of the title and content are sent, and moves the note to the end of another of the caller's sections when `sectionId` is sent. This is what autosave calls.",
        tags: ['Notes'],
        params: noteParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: ['string', 'null'], maxLength: NOTE_MAX_TITLE_LENGTH },
            content: { type: 'string' },
            sectionId: uuid
          }
        },
        response: {
          200: {
            description: 'The note is saved',
            type: 'object',
            properties: { updatedAt: { type: 'string', format: 'date-time' } }
          },
          400: { $ref: 'ApiError#' },
          413: { $ref: 'ApiError#' },
          ...NOTE_ERRORS
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId, noteId } = req.params
      const { content, sectionId } = req.body
      if (content !== undefined) {
        assertNoteContentWithinCap(content)
      }
      if (sectionId !== undefined && !(await ownsSection(siteId, userId, sectionId))) {
        return reply.notFound(SECTION_MISSING)
      }
      const changes: { title?: string | null; content?: string; sectionId?: string } = {}
      const title = normalizeTitle(req.body.title)
      if (title !== undefined) {
        changes.title = title
      }
      if (content !== undefined) {
        changes.content = content
      }
      if (sectionId !== undefined) {
        changes.sectionId = sectionId
      }
      const note = await CARDINAL.models.notes.updateNote(siteId, userId, noteId, changes)
      if (!note) {
        return reply.notFound(NOTE_MISSING)
      }
      return { updatedAt: note.updatedAt }
    }
  )

  app.delete<{ Params: NoteParams }>(
    '/sites/:siteId/notes/:noteId',
    {
      schema: {
        summary: 'Delete a note',
        description: 'Deletes the note and its images.',
        tags: ['Notes'],
        params: noteParams,
        response: { 200: okResponse, ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      if (!(await CARDINAL.models.notes.deleteNote(req.params.siteId, userId, req.params.noteId))) {
        return reply.notFound(NOTE_MISSING)
      }
      return { ok: true }
    }
  )

  app.post<{ Params: NoteParams }>(
    '/sites/:siteId/notes/:noteId/images',
    {
      schema: {
        summary: 'Add an image to a note',
        description: `A \`multipart/form-data\` body carrying one file. PNG, JPEG, GIF and WebP are accepted, decided by the bytes rather than the declared type; SVG is not. At most ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The image is readable only by the note's owner, from the returned \`url\`.`,
        tags: ['Notes'],
        consumes: ['multipart/form-data'],
        params: noteParams,
        response: {
          200: { description: 'The stored image', $ref: 'NoteImageUpload#' },
          400: { $ref: 'ApiError#' },
          413: { $ref: 'ApiError#' },
          ...NOTE_ERRORS
        }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId, noteId } = req.params
      if (!(await CARDINAL.models.notes.getNote(siteId, userId, noteId))) {
        return reply.notFound(NOTE_MISSING)
      }
      if (!req.isMultipart()) {
        return reply.badRequest('Send the image as a multipart/form-data file.')
      }
      const part = await req.file()
      if (!part) {
        return reply.badRequest('No image was sent.')
      }
      const data = await part.toBuffer()
      const mimeType = detectImageMime(data)
      if (!mimeType) {
        return reply.badRequest('Only PNG, JPEG, GIF and WebP images can be added to a note.')
      }
      const image = await CARDINAL.models.notes.addImage(siteId, userId, noteId, {
        fileName: safeImageFileName(part.filename, mimeType),
        mimeType,
        data
      })
      if (!image) {
        return reply.notFound(NOTE_MISSING)
      }
      return { id: image.id, url: noteImageUrl(siteId, noteId, image.id) }
    }
  )

  app.get<{ Params: ImageParams }>(
    '/sites/:siteId/notes/:noteId/images/:imageId',
    {
      schema: {
        summary: 'Get a note image',
        description: "The image's bytes, for the note's owner only.",
        tags: ['Notes'],
        params: imageParams,
        response: { ...NOTE_ERRORS }
      }
    },
    async (req, reply) => {
      const userId = await notesCaller(req, reply)
      if (!userId) {
        return reply
      }
      const { siteId, noteId, imageId } = req.params
      const image = await CARDINAL.models.notes.getImage(siteId, userId, noteId, imageId)
      if (!image) {
        return reply.notFound(IMAGE_MISSING)
      }
      if (
        notModifiedOrPrepare(req, reply, {
          etag: `"${image.id}"`,
          cacheControl: IMAGE_CACHE_CONTROL
        })
      ) {
        return reply
      }
      return reply.type(image.mimeType).send(Buffer.from(image.data))
    }
  )
}

export default routes
