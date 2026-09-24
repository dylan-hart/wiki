import { CustomError } from './common.ts'
import { findWhiteboardCapViolation, type WhiteboardCapViolation } from './whiteboardLimits.ts'
import { whiteboardBodiesInMarkdown } from './whiteboardMarkdown.ts'

export const NOTE_MAX_CONTENT_BYTES = 2_097_152

export const NOTE_MAX_TITLE_LENGTH = 255

/**
 * The most image bytes one user may keep in their notes on one site. Note images are `bytea` in
 * postgres (see `docs/decisions/2026-09-23-personal-notes-data-model.md`), so without a ceiling one
 * account could grow the database without bound. Counted over every image the user still has
 * stored, including ones removed from a note that `models/notes.ts#purgeOrphanImages` has not yet
 * swept.
 */
export const NOTE_IMAGE_QUOTA_BYTES = 104_857_600

export function describeNoteWhiteboardViolation(violation: WhiteboardCapViolation): string {
  switch (violation.kind) {
    case 'blockBytes':
      return `A whiteboard in this note is ${violation.actual} bytes, over the ${violation.limit}-byte limit for one whiteboard. The note was not saved.`
    case 'pageBytes':
      return `The whiteboards in this note total ${violation.actual} bytes, over the ${violation.limit}-byte limit for one note. The note was not saved.`
    case 'strokes':
      return `A whiteboard in this note has ${violation.actual} strokes, over the limit of ${violation.limit}. The note was not saved.`
    case 'points':
      return `A whiteboard in this note has ${violation.actual} points, over the limit of ${violation.limit}. The note was not saved.`
  }
}

export function assertNoteContentWithinCap(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > NOTE_MAX_CONTENT_BYTES) {
    throw new CustomError(
      'noteContentTooLarge',
      `This note is ${bytes} bytes, over the ${NOTE_MAX_CONTENT_BYTES}-byte limit for one note. The note was not saved.`,
      413
    )
  }
  const violation = findWhiteboardCapViolation(whiteboardBodiesInMarkdown(content))
  if (violation) {
    throw new CustomError('noteWhiteboardTooLarge', describeNoteWhiteboardViolation(violation))
  }
}
