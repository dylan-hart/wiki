import { CustomError } from './common.ts'
import { findWhiteboardCapViolation, type WhiteboardCapViolation } from './whiteboardLimits.ts'

export const NOTE_MAX_CONTENT_BYTES = 2_097_152

export const NOTE_MAX_TITLE_LENGTH = 255

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/

export function whiteboardBodiesInMarkdown(markdown: string): string[] {
  const bodies: string[] = []
  const lines = markdown.split(/\r?\n/)
  let fence: { marker: string; indent: number; whiteboard: boolean; body: string[] } | null = null

  for (const line of lines) {
    if (!fence) {
      const open = FENCE_OPEN.exec(line)
      if (open) {
        fence = {
          marker: open[2]!,
          indent: open[1]!.length,
          whiteboard: open[3]!.toLowerCase() === 'whiteboard',
          body: []
        }
      }
      continue
    }
    const trimmed = line.trim()
    if (
      trimmed.length >= fence.marker.length &&
      trimmed === fence.marker[0]!.repeat(trimmed.length)
    ) {
      if (fence.whiteboard) {
        bodies.push(fence.body.join('\n'))
      }
      fence = null
      continue
    }
    if (fence.whiteboard) {
      const leading = /^\s*/.exec(line)![0].length
      fence.body.push(line.slice(Math.min(leading, fence.indent)))
    }
  }

  if (fence?.whiteboard) {
    bodies.push(fence.body.join('\n'))
  }
  return bodies
}

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
