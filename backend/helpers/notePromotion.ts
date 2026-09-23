import { and, eq, inArray } from 'drizzle-orm'
import { escapeRegExp } from 'es-toolkit/string'
import {
  noteImages as noteImagesTable,
  notes as notesTable,
  pages as pagesTable
} from '../db/schema.ts'
import { CustomError, normalizePagePath } from './common.ts'
import type { PageActor } from '../models/pages.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const FILES_PREFIX = '/_files/'

export interface NoteImageRef {
  noteId: string
  imageId: string
}

export interface NoteImageTarget {
  content: string
  render: string
}

export interface PromoteNoteInput {
  siteId: string
  noteId: string
  actor: PageActor
  path: string
  title: string
  locale: string
  publishState: 'draft' | 'published'
  render?: string
  noteUpdatedAt?: string
  mayUploadTo: (folderPath: string, fileName: string) => boolean
}

export interface PromoteNoteResult {
  pageId: string
  path: string
  locale: string
  images: number
}

export function noteImageUrl(siteId: string, noteId: string, imageId: string): string {
  return `/_api/sites/${siteId}/notes/${noteId}/images/${imageId}`
}

function noteImagePattern(siteId: string): RegExp {
  return new RegExp(
    `(?:https?://[^/\\s"'()<>]+)?/_api/sites/${escapeRegExp(siteId)}/notes/(${UUID})/images/(${UUID})(?![\\w/-])`,
    'gi'
  )
}

function refKey(noteId: string, imageId: string): string {
  return `${noteId.toLowerCase()}/${imageId.toLowerCase()}`
}

export function findNoteImageRefs(text: string, siteId: string): NoteImageRef[] {
  const found = new Map<string, NoteImageRef>()
  for (const match of text.matchAll(noteImagePattern(siteId))) {
    const noteId = match[1]!.toLowerCase()
    const imageId = match[2]!.toLowerCase()
    found.set(refKey(noteId, imageId), { noteId, imageId })
  }
  return [...found.values()]
}

export function rewriteNoteImageRefs(
  text: string,
  siteId: string,
  targetFor: (ref: NoteImageRef) => string | undefined
): string {
  return text.replace(noteImagePattern(siteId), (match, noteId: string, imageId: string) => {
    return targetFor({ noteId: noteId.toLowerCase(), imageId: imageId.toLowerCase() }) ?? match
  })
}

export function assetTargets(folderPath: string, fileName: string): NoteImageTarget {
  const relative = folderPath ? `${folderPath}/${fileName}` : fileName
  return { content: `/${relative}`, render: `${FILES_PREFIX}${relative}` }
}

export function parentFolderOf(path: string): string {
  return normalizePagePath(path).split('/').slice(0, -1).join('/')
}

function sameInstant(stored: unknown, sent: string): boolean {
  const storedMs = new Date(stored as string | Date).getTime()
  const sentMs = new Date(sent).getTime()
  return Number.isFinite(storedMs) && Number.isFinite(sentMs) && storedMs === sentMs
}

export async function promoteNote(input: PromoteNoteInput): Promise<PromoteNoteResult | null> {
  const { siteId, noteId, actor } = input
  if (input.render !== undefined && !input.noteUpdatedAt) {
    throw new CustomError(
      'noteUpdatedAtMissing',
      'A render must say which version of the note it was made from.'
    )
  }
  const path = normalizePagePath(input.path)
  const folderPath = parentFolderOf(path)
  const afterCommit: Array<() => Promise<void>> = []

  const outcome = await CARDINAL.db.transaction(async (tx) => {
    // -> Locked so a concurrent autosave waits for this transaction and then finds no note, instead
    //    of writing content that the deletion below would silently throw away.
    const [note] = await tx
      .select({
        id: notesTable.id,
        content: notesTable.content,
        updatedAt: notesTable.updatedAt
      })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.id, noteId),
          eq(notesTable.siteId, siteId),
          eq(notesTable.userId, actor.id)
        )
      )
      .limit(1)
      .for('update')
    if (!note) {
      return null
    }
    if (input.noteUpdatedAt && !sameInstant(note.updatedAt, input.noteUpdatedAt)) {
      throw new CustomError(
        'noteChanged',
        'The note changed while it was being promoted. Try again.',
        409
      )
    }

    const content = note.content ?? ''
    const refs = findNoteImageRefs(content, siteId)
    // -> Only images the content still shows are re-homed. An image the note no longer references
    //    goes with the note. One copied in from another of the caller's notes is duplicated as an
    //    asset and stays with that note. Another user's image never matches, because of the
    //    `userId` filter.
    const images =
      refs.length > 0
        ? (
            await tx
              .select({
                id: noteImagesTable.id,
                noteId: noteImagesTable.noteId,
                fileName: noteImagesTable.fileName,
                mimeType: noteImagesTable.mimeType,
                data: noteImagesTable.data
              })
              .from(noteImagesTable)
              .where(
                and(
                  inArray(
                    noteImagesTable.id,
                    refs.map((ref) => ref.imageId)
                  ),
                  eq(noteImagesTable.siteId, siteId),
                  eq(noteImagesTable.userId, actor.id)
                )
              )
          ).filter((image) =>
            refs.some(
              (ref) =>
                ref.imageId === image.id.toLowerCase() && ref.noteId === image.noteId.toLowerCase()
            )
          )
        : []

    for (const image of images) {
      if (!input.mayUploadTo(folderPath, image.fileName)) {
        throw new CustomError(
          'notePromoteAssetsForbidden',
          'You are not allowed to upload files where this page is going.',
          403
        )
      }
    }

    const created = await CARDINAL.models.pages.insertPageRows(
      siteId,
      {
        path,
        title: input.title,
        locale: input.locale,
        editor: 'wysiwyg',
        content,
        publishState: input.publishState,
        ...(input.render !== undefined ? { render: input.render } : {})
      },
      actor,
      { tx }
    )

    if (images.length > 0) {
      const folderId = folderPath
        ? (
            await CARDINAL.models.tree.getFolder({
              path: folderPath,
              locale: created.page.locale,
              siteId,
              createIfMissing: true,
              db: tx
            })
          ).id
        : undefined

      const targets = new Map<string, NoteImageTarget>()
      for (const image of images) {
        const asset = await CARDINAL.models.assets.upload({
          siteId,
          locale: created.page.locale,
          folderId,
          fileName: image.fileName,
          mimeType: image.mimeType,
          data: Buffer.from(image.data),
          authorId: actor.id,
          tx,
          afterCommit
        })
        targets.set(refKey(image.noteId, image.id), assetTargets(asset.folderPath, asset.fileName))
      }

      const targetOf = (ref: NoteImageRef) => targets.get(refKey(ref.noteId, ref.imageId))
      const rewrittenContent = rewriteNoteImageRefs(
        content,
        siteId,
        (ref) => targetOf(ref)?.content
      )
      const rewrittenRender = rewriteNoteImageRefs(
        created.page.render ?? '',
        siteId,
        (ref) => targetOf(ref)?.render
      )
      await tx
        .update(pagesTable)
        .set({ content: rewrittenContent, render: rewrittenRender })
        .where(eq(pagesTable.id, created.page.id))
      created.page.content = rewrittenContent
      created.page.render = rewrittenRender
    }

    await tx
      .delete(notesTable)
      .where(
        and(
          eq(notesTable.id, note.id),
          eq(notesTable.siteId, siteId),
          eq(notesTable.userId, actor.id)
        )
      )

    return { created, images: images.length }
  })

  if (!outcome) {
    return null
  }

  for (const effect of afterCommit) {
    try {
      await effect()
    } catch (err: any) {
      CARDINAL.logger.warn('assets', 'finishing a promoted note image failed', {
        site: siteId,
        error: err
      })
    }
  }

  const { page } = outcome.created
  try {
    await CARDINAL.models.pages.completePageCreate(siteId, outcome.created, {}, actor)
  } catch (err: any) {
    CARDINAL.logger.warn('pages', 'finishing a promoted note page failed', {
      site: siteId,
      page: page.id,
      error: err
    })
  }

  CARDINAL.logger.info('pages', 'promoted a note', {
    site: siteId,
    page: page.id,
    path: page.path,
    locale: page.locale,
    images: outcome.images,
    user: actor.id
  })

  return { pageId: page.id, path: page.path, locale: page.locale, images: outcome.images }
}
