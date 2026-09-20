import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { CustomError } from '../helpers/common.ts'
import { parseFrontMatter } from '../helpers/pageSerialization.ts'

const IMPORT_TIMEOUT = 30 * 1000

/**
 * Also used as `execFile`'s `maxBuffer`: the converted Markdown coming back out has to fit the same
 * budget as what went in.
 */
export const MAX_IMPORT_SIZE = 25 * 1024 * 1024

/**
 * Each pandoc-format file in a batch spawns its own pandoc process, so this bounds how many
 * concurrent conversions one request can trigger rather than any storage concern. A `markdown` file
 * spawns no process at all but shares the cap — one limit for the whole batch, not one per format.
 */
export const MAX_IMPORT_BATCH_FILES = 20

/**
 * Bounds the product of `MAX_IMPORT_SIZE` and `MAX_IMPORT_BATCH_FILES`, which is otherwise ~500 MB
 * of Node heap resident before a single file is converted. The batch handler converts each file as
 * it finishes reading it, so this is the backstop rather than the expected peak.
 */
export const MAX_IMPORT_BATCH_BYTES = MAX_IMPORT_SIZE * 4

const importErrorLength = 800

/**
 * Instance-wide, not per request: `MAX_IMPORT_BATCH_FILES` bounds one request, but concurrent batch
 * imports would otherwise multiply out to hundreds of pandoc children. Gating in front of every
 * caller of {@link Import.runPandoc} covers both. A small window rather than
 * `models/renderQueue.ts`'s strict one-at-a-time queue, since a pandoc process is far cheaper than
 * a browser.
 */
export const MAX_CONCURRENT_PANDOC = 4

let activePandocCount = 0

const pandocQueue: Array<() => void> = []

function acquirePandocSlot(): Promise<void> {
  if (activePandocCount < MAX_CONCURRENT_PANDOC) {
    activePandocCount++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    pandocQueue.push(resolve)
  })
}

/**
 * Hands the slot straight to the next waiting caller rather than decrementing, which would let a
 * fresh `acquirePandocSlot()` race a queued one for it.
 */
function releasePandocSlot(): void {
  const next = pandocQueue.shift()
  if (next) {
    next()
    return
  }
  activePandocCount--
}

/**
 * `-f` values pandoc understands, narrowed to the readers that make sense as a *wiki page* import.
 * Pandoc's other readers — BibTeX, CSV, JATS, its own JSON AST — either aren't somebody's wiki page
 * or need options this endpoint doesn't expose, so they are left out rather than accepted and left
 * to confuse whoever picks them.
 */
const PANDOC_IMPORT_FORMATS = ['mediawiki', 'textile', 'docbook', 'rst', 'docx', 'odt'] as const

export type PandocImportFormat = (typeof PANDOC_IMPORT_FORMATS)[number]

/**
 * `--sandbox` disables pandoc's filesystem access: `rst` and `docbook` implement file-inclusion
 * directives (docutils `.. include::` / `:file:`, LaTeX-style `\input`/`\include`) that would
 * otherwise read whatever the uploaded file points at off disk and return it in the converted
 * Markdown. Every accepted format is fed on stdin and produced on stdout, so it costs nothing.
 */
export function buildPandocArgs(format: PandocImportFormat): string[] {
  return ['-f', format, '-t', 'gfm', '--wrap=none', '--sandbox']
}

/**
 * Pinned to the OS temp directory rather than inheriting the backend's own working directory, which
 * is the repo root next to `config.yml`. Belt and braces alongside `--sandbox`: a pandoc reader
 * resolving relative paths outside that flag's coverage has nothing to find here.
 */
export function pandocCwd(): string {
  return tmpdir()
}

/**
 * `markdown` is not a pandoc `-f` value: it is a pass-through read of the file's UTF-8 bytes, which
 * is what makes bulk import work on an instance with no Pandoc extension installed at all.
 */
export const SUPPORTED_IMPORT_FORMATS = [...PANDOC_IMPORT_FORMATS, 'markdown'] as const

export type ImportFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number]

function isSupportedFormat(format: string): format is ImportFormat {
  return (SUPPORTED_IMPORT_FORMATS as readonly string[]).includes(format)
}

/**
 * Extension (lowercase, no dot) -> import format. Mirrored by `EXTENSION_FORMATS` in
 * `ImportPageDialog.vue` / `ImportBatchPageDialog.vue`; keep the two in step by hand.
 */
const IMPORT_EXTENSION_FORMATS: Record<string, ImportFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  wiki: 'mediawiki',
  mediawiki: 'mediawiki',
  textile: 'textile',
  dbk: 'docbook',
  docbook: 'docbook',
  rst: 'rst',
  docx: 'docx',
  odt: 'odt'
}

/** `null` for an unrecognized or absent extension: the caller reports it rather than guessing. */
export function detectImportFormat(fileName: string): ImportFormat | null {
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : null
  return ext ? (IMPORT_EXTENSION_FORMATS[ext] ?? null) : null
}

export interface ImportConversionResult {
  markdown: string
  /** Only ever set for `format: 'markdown'` with a leading YAML front-matter block. */
  title?: string
  description?: string
  tags?: string[]
}

/**
 * Turns an uploaded file into the GitHub-flavored Markdown the editor works in. Pandoc is an
 * optional extension, not a bundled dependency, so `ensureCanImport` is asked before any
 * pandoc-backed work starts and a missing binary is a clean 503 rather than a mid-conversion
 * failure. The `markdown` pass-through never calls it, having nothing to be missing.
 */
class Import {
  async isAvailable(): Promise<boolean> {
    const definition = CARDINAL.models.extensions.getDefinition('pandoc')
    return Boolean(definition) && (await CARDINAL.models.extensions.isInstalled(definition!))
  }

  async ensureCanImport(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new CustomError(
        'importPandocMissing',
        'Importing a page needs the Pandoc extension, which is not installed.',
        503
      )
    }
  }

  /**
   * `format: 'markdown'` never touches Pandoc: the bytes are decoded as UTF-8 and handed back with
   * any leading YAML front-matter split off into `title`/`description`/`tags` rather than left as
   * literal page content.
   */
  async convertToMarkdown({
    format,
    data
  }: {
    format: string
    data: Buffer
  }): Promise<ImportConversionResult> {
    if (!isSupportedFormat(format)) {
      throw new CustomError(
        'importUnsupportedFormat',
        `'${format}' is not a supported import format. Supported formats: ${SUPPORTED_IMPORT_FORMATS.join(', ')}.`,
        400
      )
    }
    if (!Buffer.isBuffer(data) || data.length < 1) {
      throw new CustomError('importEmptyFile', 'No file was sent.', 400)
    }
    if (data.length > MAX_IMPORT_SIZE) {
      throw new CustomError(
        'importFileTooLarge',
        `The file is larger than the ${Math.round(MAX_IMPORT_SIZE / 1024 / 1024)} MB limit for import.`,
        400
      )
    }

    if (format === 'markdown') {
      // -> A UTF-8 BOM (U+FEFF), common on files exported from Windows tools, sits ahead of the
      //    leading `---` and silently defeats `parseFrontMatter`'s anchored match, importing the
      //    whole front-matter block as literal page text.
      let text = data.toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1)
      }
      if (!text.trim()) {
        throw new CustomError('importNoContent', 'This file has no content to import.', 400)
      }
      const parsed = parseFrontMatter(text)
      const result: ImportConversionResult = { markdown: parsed.content }
      if (parsed.title) {
        result.title = parsed.title
      }
      if (parsed.description) {
        result.description = parsed.description
      }
      if (parsed.tags) {
        result.tags = parsed.tags
      }
      return result
    }

    await this.ensureCanImport()
    const markdown = await this.runPandoc(format, data)
    if (!markdown.trim()) {
      throw new CustomError(
        'importNoContent',
        'Pandoc converted this file but produced no usable content.',
        400
      )
    }
    return { markdown }
  }

  protected async runPandoc(format: PandocImportFormat, data: Buffer): Promise<string> {
    await acquirePandocSlot()
    try {
      return await this.execPandoc(format, data)
    } finally {
      releasePandocSlot()
    }
  }

  /**
   * `execFile`, never `exec`: `format` and the file's content are both user-controlled, and building
   * a shell command out of either would be injectable. Split out of {@link runPandoc} so the
   * concurrency gate wraps it rather than being part of it.
   */
  protected execPandoc(format: PandocImportFormat, data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'pandoc',
        buildPandocArgs(format),
        {
          timeout: IMPORT_TIMEOUT,
          maxBuffer: MAX_IMPORT_SIZE,
          windowsHide: true,
          cwd: pandocCwd()
        },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed || err.signal) {
              reject(
                new CustomError(
                  'importConversionFailed',
                  'Pandoc took too long to convert this file and was stopped.',
                  400
                )
              )
              return
            }
            const detail = (err.stderr || stderr || err.message || '').toString().trim()
            reject(
              new CustomError(
                'importConversionFailed',
                `Pandoc could not convert this file as ${format}: ${detail.slice(-importErrorLength) || 'no output'}`,
                400
              )
            )
            return
          }
          resolve(stdout.toString())
        }
      )
      // -> A file pandoc rejects outright (not a zip at all, for docx/odt) can close its stdin
      //    mid-write, which would otherwise throw as an unhandled 'error' event. The failure is
      //    already being reported through the callback above.
      child.stdin?.on('error', () => {})
      child.stdin?.end(data)
    })
  }
}

export const pageImport = new Import()
