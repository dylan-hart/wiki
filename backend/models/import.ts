import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { CustomError } from '../helpers/common.ts'
import { parseFrontMatter } from '../helpers/pageSerialization.ts'

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

/**
 * The most files a single batch import request may carry.
 *
 * Each pandoc-format file spawns its own pandoc process (`convertToMarkdown` -> `runPandoc`), so this
 * bounds how many concurrent conversions one request can trigger rather than any storage concern —
 * generous enough for "a folder of exported wiki pages" while keeping one request from turning into an
 * unbounded pandoc fork bomb. A `markdown` file spawns no process at all (OpenProject #1092) but is
 * capped by the same number for simplicity — one limit for the whole batch, not a different one per
 * format sharing it.
 */
export const MAX_IMPORT_BATCH_FILES = 20

/**
 * The most total bytes a single batch import request may buffer across every file combined.
 *
 * `MAX_IMPORT_SIZE` bounds one file; `MAX_IMPORT_BATCH_FILES` bounds how many a batch may carry —
 * but nothing bounded their product, so a full batch of maximum-size files meant ~500 MB of Node
 * heap resident at once before `api/pages.ts`'s batch handler converted a single one of them
 * (OpenProject #2204, audit `09-dos-resource.md` §10). Set to four times a single file's own limit:
 * generous for an ordinary batch of real documents, while keeping the peak well under what the old,
 * unbounded aggregate could reach. The batch handler also converts each file as soon as it finishes
 * reading it rather than only after the whole batch has arrived, so in practice far fewer than
 * `MAX_IMPORT_BATCH_FILES` worth of buffers are ever resident at the same instant — this ceiling is
 * the hard backstop for whatever slips past that.
 */
export const MAX_IMPORT_BATCH_BYTES = MAX_IMPORT_SIZE * 4

/** How much of pandoc's stderr is kept when reporting a failure, taken from the end where the error is. */
const importErrorLength = 800

/**
 * How many pandoc conversions may run at once, across every request this instance is currently
 * serving — not per request. `MAX_IMPORT_BATCH_FILES` already bounds how many conversions ONE
 * request can trigger, but nothing bounded how many such requests run at the same time: a dozen
 * concurrent batch imports could still fork ~240 pandoc children between them (OpenProject #2209,
 * audit `09-dos-resource.md` §10). Gating here, in front of every caller of {@link Import.runPandoc}
 * — the batch route and the single-file route both funnel through it — covers both in one place.
 * `models/renderQueue.ts`'s single-browser render queue is the same idea taken to a stricter
 * one-at-a-time ceiling; a pandoc process is far cheaper than a full browser, so a small concurrency
 * window is the right trade here rather than a strict queue.
 */
export const MAX_CONCURRENT_PANDOC = 4

/** How many pandoc conversions are running right now, across every caller. */
let activePandocCount = 0

/** Callers waiting for a slot, in arrival order. */
const pandocQueue: Array<() => void> = []

/** Wait for a pandoc slot, resolving immediately if the ceiling has not been reached. */
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
 * Release a pandoc slot — handed straight to the next waiting caller when there is one, rather than
 * decrementing and letting a fresh `acquirePandocSlot()` race a queued one for it. Called from a
 * `finally`, so a failed or timed-out conversion frees its slot exactly like a successful one.
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
 * Source formats that need Pandoc, as `-f` values pandoc understands.
 *
 * The subset of pandoc's readers that make sense as a *wiki page* import: markup another wiki might
 * export as (MediaWiki, Textile, DocBook, reStructuredText) plus the two office document formats
 * content commonly arrives as (docx, odt). Pandoc reads dozens of other formats — BibTeX, CSV, JATS,
 * its own JSON AST — that either aren't "somebody's wiki page" or need options this endpoint doesn't
 * expose, and are deliberately left out rather than accepted and left to confuse whoever picks them.
 */
const PANDOC_IMPORT_FORMATS = ['mediawiki', 'textile', 'docbook', 'rst', 'docx', 'odt'] as const

export type PandocImportFormat = (typeof PANDOC_IMPORT_FORMATS)[number]

/**
 * Build the argv `runPandoc` spawns, as its own pure function so a test can assert on the exact
 * argument list without mocking `execFile` or the child_process module.
 *
 * `--sandbox` disables pandoc's own filesystem access — `rst` and `docbook` both implement
 * file-inclusion directives (docutils `.. include::` / `:file:`, and LaTeX-style `\input`/`\include`)
 * that pandoc would otherwise honor, reading whatever the uploaded file points at off disk and
 * returning it in the converted Markdown. Every accepted format is fed on stdin and produced on
 * stdout, so disabling it costs no real functionality. See OpenProject #2191.
 */
export function buildPandocArgs(format: PandocImportFormat): string[] {
  return ['-f', format, '-t', 'gfm', '--wrap=none', '--sandbox']
}

/**
 * Where `runPandoc` spawns pandoc from, as its own pure function for the same testability reason as
 * {@link buildPandocArgs}.
 *
 * Pinned to the OS temp directory rather than left to inherit the backend's own working directory —
 * the repo root, next to `config.yml`, since `index.ts` refuses to boot from anywhere else. Belt and
 * braces alongside `--sandbox` above: a `cwd` with nothing sensitive in reach means even a future
 * pandoc reader that resolves relative paths outside of `--sandbox`'s coverage has nothing to find.
 * See OpenProject #2191.
 */
export function pandocCwd(): string {
  return tmpdir()
}

/**
 * Every format this endpoint accepts: the Pandoc-backed formats above, plus `markdown` (OpenProject
 * #1092) — Wiki.js's own native page format needs no conversion at all, so it is a pass-through read
 * of the file's UTF-8 bytes rather than another `-f` value handed to pandoc. This is what makes bulk
 * import possible on an instance with no Pandoc extension installed at all: migrating from another
 * Wiki.js instance, an Obsidian vault, or any docs-as-markdown repo needs none of it.
 */
export const SUPPORTED_IMPORT_FORMATS = [...PANDOC_IMPORT_FORMATS, 'markdown'] as const

export type ImportFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number]

function isSupportedFormat(format: string): format is ImportFormat {
  return (SUPPORTED_IMPORT_FORMATS as readonly string[]).includes(format)
}

/**
 * File extension (lowercase, no dot) -> the import format it implies.
 *
 * Mirrors the frontend's own `EXTENSION_FORMATS` in `ImportPageDialog.vue` / `ImportBatchPageDialog.vue`
 * (kept in step by hand — see those files' header comments), and is what `detectImportFormat` below
 * uses to resolve a per-file format from its name (OpenProject #1209), rather than one format applied
 * across an entire batch.
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

/**
 * Resolve a file's import format from its own name, the way the single- and batch-import routes now
 * detect per file (OpenProject #1209) instead of trusting one caller-declared format for a whole
 * batch. Case-insensitive on the extension; returns `null` for no extension or one this endpoint does
 * not recognize, which the caller turns into a per-file error rather than guessing.
 */
export function detectImportFormat(fileName: string): ImportFormat | null {
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : null
  return ext ? (IMPORT_EXTENSION_FORMATS[ext] ?? null) : null
}

/** What a converted file hands back — the Markdown body, plus whatever metadata the source carried. */
export interface ImportConversionResult {
  markdown: string
  /** Only ever set for `format: 'markdown'` with a leading YAML front-matter block. */
  title?: string
  description?: string
  tags?: string[]
}

/**
 * Import model
 *
 * Turns an uploaded file into the GitHub-flavored Markdown the markdown editor works in. A `markdown`
 * file is a pass-through: its bytes already ARE the page's content, so the only work is decoding UTF-8
 * and, if present, splitting a leading YAML front-matter header into title/description/tags
 * (OpenProject #1092). Every other supported format is converted by shelling out to Pandoc — an
 * extension like Puppeteer, not a bundled dependency, and one this instance may not have.
 * `ensureCanImport` is the same kind of guard `models/renderQueue.ts`'s `ensureCanRender` is for
 * Puppeteer: asked before any pandoc-backed work starts, so a missing tool is reported as a clean 503
 * rather than discovered mid-conversion — the markdown pass-through never calls it, since it has
 * nothing to be missing.
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
   * `format: 'markdown'` never touches Pandoc: the file's bytes are decoded as UTF-8 and handed back
   * as-is, with a leading YAML front-matter block (if any) split off into `title`/`description`/`tags`
   * rather than left as literal page content. Every other format still needs Pandoc.
   *
   * @throws {CustomError} `format` isn't one this endpoint accepts, the file is empty or larger than
   *   {@link MAX_IMPORT_SIZE}, or — for a non-`markdown` format — Pandoc is not installed (503, same
   *   shape as `renderPuppeteerMissing`), the file isn't valid input for the declared format (pandoc's
   *   own stderr, surfaced the way `models/extensions.ts`'s `install()` surfaces npm's), or the
   *   conversion produced nothing usable.
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
      // -> A UTF-8 BOM (U+FEFF) is common on files exported from Windows tools (Obsidian, Notepad)
      //    but isn't part of the content: left in, it sits ahead of the leading `---` and silently
      //    defeats `parseFrontMatter`'s anchored match, so the whole front-matter block would be
      //    imported as literal page text instead of being split off.
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

  /**
   * Shell out to pandoc, piping the file's bytes to stdin and reading Markdown back from stdout —
   * gated by the process-wide {@link MAX_CONCURRENT_PANDOC} ceiling so this instance never has more
   * than that many pandoc children alive at once, no matter how many requests are calling this
   * concurrently. The slot is released in a `finally`, so a rejected or timed-out conversion frees it
   * exactly like a successful one.
   */
  protected async runPandoc(format: PandocImportFormat, data: Buffer): Promise<string> {
    await acquirePandocSlot()
    try {
      return await this.execPandoc(format, data)
    } finally {
      releasePandocSlot()
    }
  }

  /**
   * The actual pandoc invocation, split out of {@link runPandoc} so the concurrency gate wraps it
   * rather than being part of it — a test can mock this method alone to observe the gate's own
   * behavior with the real ceiling in effect.
   *
   * `execFile`, never `exec`: `format` and the file's content are both user-controlled, and building
   * a shell command out of either would be injectable. Same pattern `models/extensions.ts`'s
   * `install()` uses for npm, for the same reason. A separate method (rather than inline in
   * `convertToMarkdown`) so a test can replace it without a real pandoc binary on the machine running
   * the test. The argv and `cwd` themselves come from {@link buildPandocArgs} / {@link pandocCwd} —
   * see those for why `--sandbox` and a non-repo `cwd` matter here.
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
