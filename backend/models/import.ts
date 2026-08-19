import { execFile } from 'node:child_process'
import { CustomError } from '../helpers/common.ts'

/** How long a single pandoc conversion may run before it is killed. */
const IMPORT_TIMEOUT = 30 * 1000

/**
 * The largest upload this endpoint accepts, in bytes.
 *
 * Generous enough for a real Word or OpenDocument file — a lot of that size is embedded images that
 * pandoc discards on the way to Markdown anyway — while keeping one request from tying up a pandoc
 * process indefinitely on something enormous. Also used as `execFile`'s `maxBuffer`, since the
 * converted Markdown that comes back out has to fit the same budget as what went in.
 */
export const MAX_IMPORT_SIZE = 25 * 1024 * 1024

/** How much of pandoc's stderr is kept when reporting a failure, taken from the end where the error is. */
const importErrorLength = 800

/**
 * Source formats this endpoint accepts, as `-f` values pandoc understands.
 *
 * The subset of pandoc's readers that make sense as a *wiki page* import: markup another wiki might
 * export as (MediaWiki, Textile, DocBook, reStructuredText) plus the two office document formats
 * content commonly arrives as (docx, odt). Pandoc reads dozens of other formats — BibTeX, CSV, JATS,
 * its own JSON AST — that either aren't "somebody's wiki page" or need options this endpoint doesn't
 * expose, and are deliberately left out rather than accepted and left to confuse whoever picks them.
 */
export const SUPPORTED_IMPORT_FORMATS = [
  'mediawiki',
  'textile',
  'docbook',
  'rst',
  'docx',
  'odt'
] as const

export type ImportFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number]

function isSupportedFormat(format: string): format is ImportFormat {
  return (SUPPORTED_IMPORT_FORMATS as readonly string[]).includes(format)
}

/**
 * Import model
 *
 * Converts a file in another wiki's or word processor's format into the GitHub-flavored Markdown the
 * markdown editor works in, by shelling out to Pandoc — an extension like Puppeteer, not a bundled
 * dependency, and one this instance may not have. `ensureCanImport` is the same kind of guard
 * `models/rendering.ts`'s `ensureCanRender` is for Puppeteer: asked before any work starts, so a
 * missing tool is reported as a clean 503 rather than discovered mid-conversion.
 */
class Import {
  /**
   * Whether this instance can convert a file at all.
   */
  async isAvailable(): Promise<boolean> {
    const definition = WIKI.models.extensions.getDefinition('pandoc')
    return Boolean(definition) && (await WIKI.models.extensions.isInstalled(definition!))
  }

  /**
   * Refuse the caller when this instance cannot convert anything.
   */
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
   * Convert an uploaded file to GitHub-flavored Markdown.
   *
   * @throws {CustomError} Pandoc is not installed (503, same shape as `renderPuppeteerMissing`),
   *   `format` isn't one this endpoint accepts, the file is empty or larger than
   *   {@link MAX_IMPORT_SIZE}, the file isn't valid input for the declared format (pandoc's own
   *   stderr, surfaced the way `models/extensions.ts`'s `install()` surfaces npm's), or the
   *   conversion produced nothing usable.
   */
  async convertToMarkdown({ format, data }: { format: string; data: Buffer }): Promise<string> {
    await this.ensureCanImport()

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

    const markdown = await this.runPandoc(format, data)
    if (!markdown.trim()) {
      throw new CustomError(
        'importNoContent',
        'Pandoc converted this file but produced no usable content.',
        400
      )
    }
    return markdown
  }

  /**
   * Shell out to pandoc, piping the file's bytes to stdin and reading Markdown back from stdout.
   *
   * `execFile`, never `exec`: `format` and the file's content are both user-controlled, and building
   * a shell command out of either would be injectable. Same pattern `models/extensions.ts`'s
   * `install()` uses for npm, for the same reason. A separate method (rather than inline in
   * `convertToMarkdown`) so a test can replace it without a real pandoc binary on the machine running
   * the test.
   */
  protected runPandoc(format: ImportFormat, data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'pandoc',
        ['-f', format, '-t', 'gfm', '--wrap=none'],
        { timeout: IMPORT_TIMEOUT, maxBuffer: MAX_IMPORT_SIZE, windowsHide: true },
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
            // -> pandoc says what went wrong on stderr, and the tail of it is the part worth passing on
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
      // -> A file pandoc rejects outright (not a zip at all, for docx/odt) can close its stdin before
      //    this finishes writing, which would otherwise throw here as an unhandled 'error' event —
      //    the failure is already being reported through the callback above.
      child.stdin?.on('error', () => {})
      child.stdin?.end(data)
    })
  }
}

export const pageImport = new Import()
