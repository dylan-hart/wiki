import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { commandExists } from '../models/extensions.ts'
import { readRasterHeader } from './rasterHeader.ts'

export interface OcrLimits {
  maxBytes: number
  maxChars: number
  /** The pages of a PDF rendered and recognized; a TIFF with more than this is not read at all. */
  maxPages: number
  /**
   * Checked against an image's header before tesseract sees it, since a few megabytes of
   * compressed image can describe gigabytes of decoded bitmap. Tesseract peaks at roughly 11 bytes
   * per pixel, so this is ~290 MB per worker.
   */
  maxPixels: number
  /**
   * The long side a PDF page is rendered at, whatever size its MediaBox claims: about 220 dpi for
   * Letter or A4.
   */
  pdfRenderSize: number
  commandTimeoutMs: number
  totalTimeoutMs: number
}

export const OCR_LIMITS: OcrLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxChars: 500_000,
  maxPages: 20,
  maxPixels: 25_000_000,
  pdfRenderSize: 2500,
  commandTimeoutMs: 60_000,
  totalTimeoutMs: 240_000
}

export type OcrOutcome = 'ok' | 'empty' | 'failed' | 'skipped'

export interface OcrResult {
  text: string
  outcome: OcrOutcome
  reason?: string
  truncated: boolean
}

export type OcrKind = 'image' | 'pdf'

const OCR_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/tiff',
  'image/bmp'
])

const OCR_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'])

export function ocrKindOf(fileExt: string, mimeType: string): OcrKind | null {
  if (fileExt === 'pdf' || mimeType === 'application/pdf') {
    return 'pdf'
  }
  if (OCR_IMAGE_MIME_TYPES.has(mimeType) || OCR_IMAGE_EXTS.has(fileExt)) {
    return 'image'
  }
  return null
}

export async function ocrAvailable(kind: OcrKind = 'image'): Promise<boolean> {
  if (!(await commandExists('tesseract'))) {
    return false
  }
  return kind === 'pdf' ? commandExists('pdftoppm') : true
}

class CommandError extends Error {
  reason: string

  constructor(reason: string) {
    super(reason)
    this.reason = reason
    this.name = 'CommandError'
  }
}

function runCommand(
  command: string,
  args: string[],
  input: Uint8Array | null,
  timeoutMs: number,
  maxBuffer: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'buffer',
        windowsHide: true,
        env: { ...process.env, OMP_THREAD_LIMIT: '1' }
      },
      (err, stdout) => {
        if (!err) {
          resolve(stdout)
          return
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new CommandError('not-installed'))
          return
        }
        reject(new CommandError(err.killed || err.signal ? 'timeout' : 'exit-error'))
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? undefined)
  })
}

function finish(raw: string, limits: OcrLimits, truncated: boolean): OcrResult {
  let text = raw.replaceAll('\u0000', '').trim()
  if (text.length > limits.maxChars) {
    text = text.slice(0, limits.maxChars).trim()
    truncated = true
  }
  return { text, outcome: text ? 'ok' : 'empty', truncated }
}

function fromError(err: unknown): OcrResult {
  const reason = err instanceof CommandError ? err.reason : 'unknown'
  return {
    text: '',
    outcome: reason === 'not-installed' ? 'skipped' : 'failed',
    reason,
    truncated: false
  }
}

function skipped(reason: string): OcrResult {
  return { text: '', outcome: 'skipped', reason, truncated: false }
}

/**
 * The bytes' own header decides whether they reach tesseract, never the name or type they were
 * uploaded under. Input tesseract does not recognize as an image is not rejected but read as a
 * newline-separated list of file paths, each of which it opens and OCRs — any file this process can
 * read, other sites' assets included — so anything short of a well-formed header in a format
 * {@link readRasterHeader} knows is skipped here.
 */
export async function ocrImage(
  bytes: Uint8Array,
  limits: OcrLimits = OCR_LIMITS
): Promise<OcrResult> {
  if (bytes.length > limits.maxBytes) {
    return skipped('too-large')
  }
  const header = readRasterHeader(bytes)
  if (!header) {
    return skipped('not-an-image')
  }
  if (header.pages > limits.maxPages) {
    return skipped('too-many-pages')
  }
  if (header.peakPixels > limits.maxPixels) {
    return skipped('too-many-pixels')
  }
  try {
    const stdout = await runCommand(
      'tesseract',
      ['stdin', 'stdout'],
      bytes,
      limits.commandTimeoutMs,
      limits.maxChars * 4
    )
    return finish(stdout.toString('utf8'), limits, false)
  } catch (err) {
    return fromError(err)
  }
}

export async function ocrPdf(
  bytes: Uint8Array,
  limits: OcrLimits = OCR_LIMITS
): Promise<OcrResult> {
  if (bytes.length > limits.maxBytes) {
    return skipped('too-large')
  }

  const deadline = Date.now() + limits.totalTimeoutMs
  let dir: string | undefined
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'cardinal-ocr-'))
    await writeFile(path.join(dir, 'in.pdf'), bytes)
    await runCommand(
      'pdftoppm',
      [
        // -> A size rather than a resolution: the MediaBox is the author's to set, and 12000pt
        //    square at 150 dpi is a 25000px page pdftoppm needs gigabytes to render
        '-scale-to',
        String(limits.pdfRenderSize),
        '-png',
        '-f',
        '1',
        '-l',
        String(limits.maxPages),
        path.join(dir, 'in.pdf'),
        path.join(dir, 'page')
      ],
      null,
      Math.min(limits.commandTimeoutMs, limits.totalTimeoutMs),
      1024 * 1024
    )

    const pages = (await readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name)).sort()
    const parts: string[] = []
    let chars = 0
    let truncated = pages.length >= limits.maxPages

    for (const name of pages) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        truncated = true
        break
      }
      let stdout: Buffer
      try {
        stdout = await runCommand(
          'tesseract',
          [path.join(dir, name), 'stdout'],
          null,
          Math.min(limits.commandTimeoutMs, remaining),
          limits.maxChars * 4
        )
      } catch (err) {
        if (err instanceof CommandError && err.reason === 'timeout' && parts.length > 0) {
          truncated = true
          break
        }
        throw err
      }
      const pageText = stdout.toString('utf8').replaceAll('\u0000', '').trim()
      if (!pageText) {
        continue
      }
      parts.push(pageText)
      chars += pageText.length + 1
      if (chars >= limits.maxChars) {
        truncated = true
        break
      }
    }
    return finish(parts.join('\n'), limits, truncated)
  } catch (err) {
    return fromError(err)
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function ocrBytes(
  kind: OcrKind,
  bytes: Uint8Array,
  limits: OcrLimits = OCR_LIMITS
): Promise<OcrResult> {
  return kind === 'pdf' ? ocrPdf(bytes, limits) : ocrImage(bytes, limits)
}
