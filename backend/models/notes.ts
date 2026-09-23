import { and, asc, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { WikiDbOrTx, WikiTx } from '../core/db.ts'
import {
  noteImages as noteImagesTable,
  noteSections as noteSectionsTable,
  notes as notesTable
} from '../db/schema.ts'
import { isValidUuid } from '../helpers/common.ts'
import { noteExcerpt } from '../helpers/notes.ts'

export interface NoteSection {
  id: string
  title: string
  position: number
  createdAt: Date
  updatedAt: Date
}

export interface NoteSummary {
  id: string
  sectionId: string
  title: string | null
  excerpt: string
  position: number
  createdAt: Date
  updatedAt: Date
}

export interface Note extends NoteSummary {
  content: string
}

export interface NoteImageMeta {
  id: string
  noteId: string
  fileName: string
  mimeType: string
  fileSize: number
  createdAt: Date
}

export interface NoteImage extends NoteImageMeta {
  data: Buffer
}

export interface NoteTxOptions {
  tx?: WikiTx
}

const sectionColumns = {
  id: noteSectionsTable.id,
  title: noteSectionsTable.title,
  position: noteSectionsTable.position,
  createdAt: noteSectionsTable.createdAt,
  updatedAt: noteSectionsTable.updatedAt
}

const summaryColumns = {
  id: notesTable.id,
  sectionId: notesTable.sectionId,
  title: notesTable.title,
  excerpt: notesTable.excerpt,
  position: notesTable.position,
  createdAt: notesTable.createdAt,
  updatedAt: notesTable.updatedAt
}

const noteColumns = { ...summaryColumns, content: notesTable.content }

const imageMetaColumns = {
  id: noteImagesTable.id,
  noteId: noteImagesTable.noteId,
  fileName: noteImagesTable.fileName,
  mimeType: noteImagesTable.mimeType,
  fileSize: noteImagesTable.fileSize,
  createdAt: noteImagesTable.createdAt
}

function normalizeTitle(title: string | null | undefined): string | null {
  const trimmed = (title ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function ownsSection(siteId: string, userId: string, sectionId: string) {
  return and(
    eq(noteSectionsTable.id, sectionId),
    eq(noteSectionsTable.siteId, siteId),
    eq(noteSectionsTable.userId, userId)
  )
}

function ownsNote(siteId: string, userId: string, noteId: string) {
  return and(
    eq(notesTable.id, noteId),
    eq(notesTable.siteId, siteId),
    eq(notesTable.userId, userId)
  )
}

function hasDuplicates(ids: string[]): boolean {
  return new Set(ids).size !== ids.length
}

class Notes {
  async listSections(siteId: string, userId: string): Promise<NoteSection[]> {
    return CARDINAL.db
      .select(sectionColumns)
      .from(noteSectionsTable)
      .where(and(eq(noteSectionsTable.siteId, siteId), eq(noteSectionsTable.userId, userId)))
      .orderBy(asc(noteSectionsTable.position), asc(noteSectionsTable.createdAt))
  }

  async createSection(
    siteId: string,
    userId: string,
    { title }: { title: string }
  ): Promise<NoteSection> {
    const [row] = await CARDINAL.db
      .insert(noteSectionsTable)
      .values({
        siteId,
        userId,
        title: (title ?? '').trim(),
        position: sql<number>`(SELECT COALESCE(MAX("position"), -1) + 1 FROM ${noteSectionsTable} WHERE "siteId" = ${siteId} AND "userId" = ${userId})`
      })
      .returning(sectionColumns)
    return row!
  }

  async updateSection(
    siteId: string,
    userId: string,
    sectionId: string,
    { title }: { title: string }
  ): Promise<NoteSection | null> {
    if (!isValidUuid(sectionId)) {
      return null
    }
    const [row] = await CARDINAL.db
      .update(noteSectionsTable)
      .set({ title: (title ?? '').trim(), updatedAt: sql`now()` })
      .where(ownsSection(siteId, userId, sectionId))
      .returning(sectionColumns)
    return row ?? null
  }

  async deleteSection(siteId: string, userId: string, sectionId: string): Promise<boolean> {
    if (!isValidUuid(sectionId)) {
      return false
    }
    const rows = await CARDINAL.db
      .delete(noteSectionsTable)
      .where(ownsSection(siteId, userId, sectionId))
      .returning({ id: noteSectionsTable.id })
    return rows.length > 0
  }

  async reorderSections(siteId: string, userId: string, ids: string[]): Promise<boolean> {
    if (hasDuplicates(ids) || !ids.every(isValidUuid)) {
      return false
    }
    return CARDINAL.db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: noteSectionsTable.id })
        .from(noteSectionsTable)
        .where(and(eq(noteSectionsTable.siteId, siteId), eq(noteSectionsTable.userId, userId)))
        .orderBy(asc(noteSectionsTable.position), asc(noteSectionsTable.createdAt))
        .for('update')
      const order = mergeOrder(
        owned.map((row) => row.id),
        ids
      )
      if (!order) {
        return false
      }
      for (const [position, id] of order.entries()) {
        await tx
          .update(noteSectionsTable)
          .set({ position })
          .where(ownsSection(siteId, userId, id))
      }
      return true
    })
  }

  async listNotes(
    siteId: string,
    userId: string,
    sectionId: string
  ): Promise<NoteSummary[] | null> {
    if (!isValidUuid(sectionId)) {
      return null
    }
    const [section] = await CARDINAL.db
      .select({ id: noteSectionsTable.id })
      .from(noteSectionsTable)
      .where(ownsSection(siteId, userId, sectionId))
    if (!section) {
      return null
    }
    return CARDINAL.db
      .select(summaryColumns)
      .from(notesTable)
      .where(
        and(
          eq(notesTable.sectionId, sectionId),
          eq(notesTable.siteId, siteId),
          eq(notesTable.userId, userId)
        )
      )
      .orderBy(asc(notesTable.position), asc(notesTable.createdAt))
  }

  async getNote(
    siteId: string,
    userId: string,
    noteId: string,
    { tx }: NoteTxOptions = {}
  ): Promise<Note | null> {
    if (!isValidUuid(noteId)) {
      return null
    }
    const db: WikiDbOrTx = tx ?? CARDINAL.db
    const [row] = await db
      .select(noteColumns)
      .from(notesTable)
      .where(ownsNote(siteId, userId, noteId))
    return row ?? null
  }

  async createNote(
    siteId: string,
    userId: string,
    { sectionId, title, content }: { sectionId: string; title?: string | null; content?: string }
  ): Promise<Note | null> {
    if (!isValidUuid(sectionId)) {
      return null
    }
    return CARDINAL.db.transaction(async (tx) => {
      const [section] = await tx
        .select({ id: noteSectionsTable.id })
        .from(noteSectionsTable)
        .where(ownsSection(siteId, userId, sectionId))
        .for('update')
      if (!section) {
        return null
      }
      const body = content ?? ''
      const [row] = await tx
        .insert(notesTable)
        .values({
          siteId,
          userId,
          sectionId,
          title: normalizeTitle(title),
          content: body,
          excerpt: noteExcerpt(body),
          position: nextNotePosition(sectionId)
        })
        .returning(noteColumns)
      return row!
    })
  }

  async updateNote(
    siteId: string,
    userId: string,
    noteId: string,
    patch: { title?: string | null; content?: string; sectionId?: string }
  ): Promise<Note | null> {
    if (!isValidUuid(noteId)) {
      return null
    }
    if (patch.sectionId !== undefined && !isValidUuid(patch.sectionId)) {
      return null
    }
    return CARDINAL.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ sectionId: notesTable.sectionId })
        .from(notesTable)
        .where(ownsNote(siteId, userId, noteId))
        .for('update')
      if (!current) {
        return null
      }
      const set: PgUpdateSetSource<typeof notesTable> = { updatedAt: sql`now()` }
      if (patch.title !== undefined) {
        set.title = normalizeTitle(patch.title)
      }
      if (patch.content !== undefined) {
        set.content = patch.content
        set.excerpt = noteExcerpt(patch.content)
      }
      if (patch.sectionId !== undefined && patch.sectionId !== current.sectionId) {
        const [target] = await tx
          .select({ id: noteSectionsTable.id })
          .from(noteSectionsTable)
          .where(ownsSection(siteId, userId, patch.sectionId))
          .for('update')
        if (!target) {
          return null
        }
        set.sectionId = patch.sectionId
        set.position = nextNotePosition(patch.sectionId)
      }
      const [row] = await tx
        .update(notesTable)
        .set(set)
        .where(ownsNote(siteId, userId, noteId))
        .returning(noteColumns)
      return row ?? null
    })
  }

  async deleteNote(
    siteId: string,
    userId: string,
    noteId: string,
    { tx }: NoteTxOptions = {}
  ): Promise<boolean> {
    if (!isValidUuid(noteId)) {
      return false
    }
    const db: WikiDbOrTx = tx ?? CARDINAL.db
    const rows = await db
      .delete(notesTable)
      .where(ownsNote(siteId, userId, noteId))
      .returning({ id: notesTable.id })
    return rows.length > 0
  }

  async reorderNotes(
    siteId: string,
    userId: string,
    sectionId: string,
    ids: string[]
  ): Promise<boolean> {
    if (!isValidUuid(sectionId) || hasDuplicates(ids) || !ids.every(isValidUuid)) {
      return false
    }
    return CARDINAL.db.transaction(async (tx) => {
      const [section] = await tx
        .select({ id: noteSectionsTable.id })
        .from(noteSectionsTable)
        .where(ownsSection(siteId, userId, sectionId))
        .for('update')
      if (!section) {
        return false
      }
      const owned = await tx
        .select({ id: notesTable.id })
        .from(notesTable)
        .where(
          and(
            eq(notesTable.sectionId, sectionId),
            eq(notesTable.siteId, siteId),
            eq(notesTable.userId, userId)
          )
        )
        .orderBy(asc(notesTable.position), asc(notesTable.createdAt))
      const order = mergeOrder(
        owned.map((row) => row.id),
        ids
      )
      if (!order) {
        return false
      }
      for (const [position, id] of order.entries()) {
        await tx
          .update(notesTable)
          .set({ position })
          .where(ownsNote(siteId, userId, id))
      }
      return true
    })
  }

  async addImage(
    siteId: string,
    userId: string,
    noteId: string,
    { fileName, mimeType, data }: { fileName: string; mimeType: string; data: Buffer }
  ): Promise<NoteImageMeta | null> {
    if (!isValidUuid(noteId)) {
      return null
    }
    return CARDINAL.db.transaction(async (tx) => {
      const [note] = await tx
        .select({ id: notesTable.id })
        .from(notesTable)
        .where(ownsNote(siteId, userId, noteId))
        .for('share')
      if (!note) {
        return null
      }
      const [row] = await tx
        .insert(noteImagesTable)
        .values({ siteId, userId, noteId, fileName, mimeType, fileSize: data.length, data })
        .returning(imageMetaColumns)
      return row!
    })
  }

  async getImage(
    siteId: string,
    userId: string,
    noteId: string,
    imageId: string,
    { tx }: NoteTxOptions = {}
  ): Promise<NoteImage | null> {
    if (!isValidUuid(noteId) || !isValidUuid(imageId)) {
      return null
    }
    const db: WikiDbOrTx = tx ?? CARDINAL.db
    const [row] = await db
      .select({ ...imageMetaColumns, data: noteImagesTable.data })
      .from(noteImagesTable)
      .where(
        and(
          eq(noteImagesTable.id, imageId),
          eq(noteImagesTable.noteId, noteId),
          eq(noteImagesTable.siteId, siteId),
          eq(noteImagesTable.userId, userId)
        )
      )
    return row ?? null
  }

  async listImages(
    siteId: string,
    userId: string,
    noteId: string,
    { tx }: NoteTxOptions = {}
  ): Promise<NoteImageMeta[] | null> {
    if (!isValidUuid(noteId)) {
      return null
    }
    const db: WikiDbOrTx = tx ?? CARDINAL.db
    const [note] = await db
      .select({ id: notesTable.id })
      .from(notesTable)
      .where(ownsNote(siteId, userId, noteId))
    if (!note) {
      return null
    }
    return db
      .select(imageMetaColumns)
      .from(noteImagesTable)
      .where(
        and(
          eq(noteImagesTable.noteId, noteId),
          eq(noteImagesTable.siteId, siteId),
          eq(noteImagesTable.userId, userId)
        )
      )
      .orderBy(asc(noteImagesTable.createdAt), asc(noteImagesTable.id))
  }
}

function nextNotePosition(sectionId: string) {
  return sql<number>`(SELECT COALESCE(MAX("position"), -1) + 1 FROM ${notesTable} WHERE "sectionId" = ${sectionId})`
}

export function mergeOrder(owned: string[], requested: string[]): string[] | null {
  const ownedSet = new Set(owned)
  if (!requested.every((id) => ownedSet.has(id))) {
    return null
  }
  const requestedSet = new Set(requested)
  return [...requested, ...owned.filter((id) => !requestedSet.has(id))]
}

export const notes = new Notes()
