import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  NotYetImplementedError,
  type SourceAssetFile,
  type SourceConnector,
  type SourceDescription,
  type SourceRecord
} from '../connector.ts'

/**
 * The file (or directory, for `assets`) each export entity is written under the bundle root, per
 * `docs/migration/2.5x-export-bundle-format.md`. Every entity is independently optional — a bundle
 * exported with only a subset of entities checked is a complete, valid bundle for that subset.
 */
/** Merges a row's denormalized `tags: [{tag, title}]` (or an already-plain `tags: string[]`) into
 * `seen`, keyed by tag string so a tag appearing on many pages is only kept once. Used by `tags()`
 * below, the one generator this connector kind has to derive rather than read off a dedicated file. */
function collectTags(tags: unknown, seen: Map<string, SourceRecord>): void {
  if (!Array.isArray(tags)) return
  for (const entry of tags) {
    if (typeof entry === 'string') {
      if (!seen.has(entry)) seen.set(entry, { tag: entry, title: null })
    } else if (entry && typeof entry === 'object' && 'tag' in entry) {
      const tag = (entry as { tag: unknown }).tag
      if (typeof tag === 'string' && !seen.has(tag)) {
        const title = 'title' in entry ? ((entry as { title: unknown }).title ?? null) : null
        seen.set(tag, { tag, title })
      }
    }
  }
}

/**
 * Incrementally parses a top-level JSON array of row objects as decoded text arrives in chunks,
 * without ever holding more than the current in-flight object (plus a small unconsumed tail) in
 * memory. `docs/migration/2.5x-export-bundle-format.md` documents every `.json.gz` entity file as one
 * pretty-printed JSON array of row objects written by the exporter's own batch-fetch loop — this walks
 * it at the `{`/`}`/`,` boundaries pretty-printing makes visible, tracking string/escape state so a
 * brace or comma inside a quoted value is never mistaken for a structural one, and bracket depth so a
 * nested array/object inside a row (e.g. `tags: [...]`) does not end the row early.
 *
 * Exported (beyond `readGzipJsonArray`'s own use of it) so its incremental-yield behavior — the actual
 * mechanism `readGzipJsonArray` relies on to yield a row before the rest of the file has even been
 * decompressed — has a direct, deterministic unit test independent of OS-level stream chunk sizing.
 */
export class JsonArrayStreamParser {
  private readonly filePath: string
  private buffer = ''
  /** Absolute index into `buffer` of the next character to scan — persisted across `push()` calls so
   * a chunk boundary landing mid-object never causes already-scanned characters to be rescanned (which
   * would double-count their effect on `depth`/`inString`). */
  private pos = 0
  private sawOpenBracket = false
  private sawCloseBracket = false
  /** Index into `buffer` where the in-flight row object begins, or -1 between objects. */
  private objectStart = -1
  private depth = 0
  private inString = false
  private escapeNext = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private notAnArrayError(): Error {
    return new Error(
      `"${this.filePath}" does not contain a JSON array, as every 2.5.x entity file does.`
    )
  }

  /** Feeds one more chunk of decoded text, yielding every row object that completes as a result. */
  *push(chunk: string): Generator<SourceRecord> {
    this.buffer += chunk
    let i = this.pos
    while (i < this.buffer.length) {
      const ch = this.buffer[i]

      if (this.sawCloseBracket) {
        // Trailing whitespace (or, in principle, other junk) after the array's own `]` — nothing left
        // to parse. Advance past it rather than reinterpreting it as more array content.
        i++
        continue
      }

      if (this.objectStart === -1) {
        // Between objects: whitespace, the opening `[`, a `,` separator, the closing `]`, or the `{`
        // starting the next row object.
        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
          i++
          continue
        }
        if (!this.sawOpenBracket) {
          if (ch !== '[') throw this.notAnArrayError()
          this.sawOpenBracket = true
          i++
          continue
        }
        if (ch === ',') {
          i++
          continue
        }
        if (ch === ']') {
          this.sawCloseBracket = true
          i++
          continue
        }
        if (ch === '{') {
          this.objectStart = i
          this.depth = 1
          this.inString = false
          this.escapeNext = false
          i++
          continue
        }
        throw this.notAnArrayError()
      }

      // Scanning inside a row object: track string/escape state so structural characters inside a
      // quoted value are ignored, and bracket depth so a nested `{}`/`[]` doesn't end the row early.
      if (this.inString) {
        if (this.escapeNext) {
          this.escapeNext = false
        } else if (ch === '\\') {
          this.escapeNext = true
        } else if (ch === '"') {
          this.inString = false
        }
        i++
        continue
      }
      if (ch === '"') {
        this.inString = true
        i++
        continue
      }
      if (ch === '{' || ch === '[') {
        this.depth++
        i++
        continue
      }
      if (ch === '}' || ch === ']') {
        this.depth--
        i++
        if (this.depth === 0) {
          const objectText = this.buffer.slice(this.objectStart, i)
          this.objectStart = -1
          yield JSON.parse(objectText) as SourceRecord
        }
        continue
      }
      i++
    }
    // Keep only the unconsumed tail (a row object still mid-scan) for the next chunk — never the
    // whole buffer seen so far — and re-anchor `pos` so the next push() resumes scanning right after
    // what's already been scanned, rather than re-scanning it (which would double-count its effect on
    // `depth`/`inString`).
    if (this.objectStart === -1) {
      this.buffer = ''
      this.pos = 0
    } else {
      this.buffer = this.buffer.slice(this.objectStart)
      this.pos = this.buffer.length
      this.objectStart = 0
    }
  }

  /** Call once the underlying stream has ended, to confirm the array actually closed. */
  finish(): void {
    if (!this.sawOpenBracket || !this.sawCloseBracket || this.objectStart !== -1) {
      throw this.notAnArrayError()
    }
  }
}

const ENTITY_FILES: Record<string, string> = {
  users: 'users.json.gz',
  groups: 'groups.json',
  pages: 'pages.json.gz',
  pageHistory: 'pages-history.json.gz',
  comments: 'comments.json.gz',
  navigation: 'navigation.json',
  settings: 'settings.json',
  assets: 'assets'
}

/** Drains an async iterable purely for its side effects, ignoring the values it yields. Used to walk
 * `pages()`/`pageHistory()` for their `collectTags` side effect without keeping the rows around. */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]()
  while (!(await iterator.next()).done) {
    // No-op: the generator's own side effect (collectTags, in this module's use of it) already ran.
  }
}

/**
 * ExportBundleSourceConnector
 *
 * Opens a directory produced by 2.5.x's "Export to disk" system utility and validates it actually
 * looks like one: at least one of the eight known entity files/directories must be present, and the
 * three small, ungzipped files (`settings.json`, `navigation.json`, `groups.json`) are parsed and
 * shape-checked against `2.5x-export-bundle-format.md` to prove the format assumption this connector
 * — and the later importer tasks reading through it — depends on.
 *
 * `pages()`, `pageHistory()`, `tags()` and `navigation()` are implemented for real (Task 733, this
 * feature's own extraction scaffold) — the rest (`users()`, `groups()`, `settings()`, `assets()`)
 * remain `NotYetImplementedError` stubs, deferred to the tasks that own those entities. `connect()`
 * already parses `groups.json`/`navigation.json`/`settings.json` once for shape-validation, but that
 * parsed data is not retained or reused by `navigation()` below, which re-reads and re-parses the file
 * on its own — keeping `connect()`'s validation pass and an entity generator's real read independent,
 * the same way the still-deferred generators are documented as depending on nothing `connect()` did.
 */
export class ExportBundleSourceConnector implements SourceConnector {
  readonly kind = 'export-bundle' as const

  private readonly bundlePath: string
  private notes: string[] = []
  private detectedVersion: string | undefined
  private connected = false

  /** Tags collected as a side effect of walking `pages()`/`pageHistory()` — see `tagsImpl()`. */
  private readonly tagsSeen: Map<string, SourceRecord> = new Map()
  private pagesTagsCollected = false
  private pageHistoryTagsCollected = false

  constructor(bundlePath: string) {
    this.bundlePath = bundlePath
  }

  async connect(): Promise<void> {
    const stat = await fs.stat(this.bundlePath).catch(() => null)
    if (!stat?.isDirectory()) {
      throw new Error(`"${this.bundlePath}" is not a directory — an export bundle must be one.`)
    }

    const present = new Set<string>()
    for (const [entity, file] of Object.entries(ENTITY_FILES)) {
      const exists = await fs
        .access(path.join(this.bundlePath, file))
        .then(() => true)
        .catch(() => false)
      if (exists) {
        present.add(entity)
      }
    }
    if (present.size === 0) {
      throw new Error(
        `"${this.bundlePath}" does not look like a 2.5.x export bundle — none of the expected files ` +
          `(${Object.values(ENTITY_FILES).join(', ')}) were found.`
      )
    }

    const notes = [`Detected entities: ${[...present].sort().join(', ')}.`]
    let detectedVersion: string | undefined

    // Read + shape-check the three small, ungzipped files — proving the format assumption without
    // touching the large batched/gzipped files, which stay untouched until Tasks 414/416/418 read
    // them for real.

    if (present.has('settings')) {
      const settings = await this.readJson(path.join(this.bundlePath, 'settings.json'))
      if (
        typeof settings !== 'object' ||
        settings === null ||
        Array.isArray(settings) ||
        !('modules' in settings)
      ) {
        throw new Error(
          'settings.json does not have the expected shape (a merged config object with a "modules" key).'
        )
      }
      notes.push('settings.json parses as an object with the expected "modules" key.')
    }

    if (present.has('navigation')) {
      const navigation = await this.readJson(path.join(this.bundlePath, 'navigation.json'))
      if (typeof navigation !== 'object' || navigation === null || Array.isArray(navigation)) {
        throw new Error(
          'navigation.json does not have the expected shape (a {key: config} object, not an array).'
        )
      }
      notes.push('navigation.json parses as a keyed object, as documented.')
    }

    if (present.has('groups')) {
      const groups = await this.readJson(path.join(this.bundlePath, 'groups.json'))
      if (!Array.isArray(groups)) {
        throw new Error('groups.json does not have the expected shape (an array of group rows).')
      }
      if (groups.length === 0) {
        notes.push(
          'groups.json is an empty array — cannot confirm the 2.5.12 minimum-version floor from it.'
        )
      } else if (
        groups.every((g) => typeof g === 'object' && g !== null && 'redirectOnLogin' in g)
      ) {
        // Every group carries `redirectOnLogin`, added in `2.5.12.js` — the minimum-version signal
        // docs/migration/decision-source-scope.md calls for on the bundle path.
        detectedVersion = '>=2.5.12'
        notes.push(
          'Every group has "redirectOnLogin" — source is at or after 2.5.12, per decision-source-scope.md.'
        )
      } else {
        notes.push(
          'At least one group is missing "redirectOnLogin" — source predates 2.5.12, below the supported floor.'
        )
      }
    }

    this.notes = notes
    this.detectedVersion = detectedVersion
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async describe(): Promise<SourceDescription> {
    if (!this.connected) {
      throw new Error('describe() called before a successful connect().')
    }
    return {
      kind: this.kind,
      location: this.bundlePath,
      version: this.detectedVersion,
      notes: this.notes
    }
  }

  private async readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  }

  users(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('users', 'Task 414 (Users/Groups importer)')
  }

  groups(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('groups', 'Task 414 (Users/Groups importer)')
  }

  /**
   * Streams one `.json.gz` entity file: `createReadStream(filePath).pipe(zlib.createGunzip())`, fed
   * chunk by chunk into a `JsonArrayStreamParser`, so a row is yielded as soon as its own closing `}`
   * arrives rather than after the whole file has been read, decompressed and turned into one JS
   * string. Peak memory is bounded to one row plus a small unconsumed tail, not the whole entity file
   * — the old `fs.readFile` + `zlib.gunzipSync(...).toString('utf8')` + `JSON.parse` approach held the
   * entire decompressed array in memory at once and threw once that string passed V8's ~512 MB
   * ceiling, which a large `pages-history.json.gz` from a big source install can exceed.
   * Yields nothing, rather than throwing, when the file is absent — every export entity is
   * independently optional (a zero-row entity is skipped entirely, per the same doc), and a missing
   * file is exactly that case, not an error. Throws the same "does not contain a JSON array" error a
   * whole-file parse would, for a top-level value that isn't an array.
   */
  private async *readGzipJsonArray(filePath: string): AsyncGenerator<SourceRecord> {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return

    const parser = new JsonArrayStreamParser(filePath)
    const decoder = new TextDecoder('utf-8')
    const fileStream = createReadStream(filePath)
    const gunzip = fileStream.pipe(zlib.createGunzip())
    try {
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        yield* parser.push(decoder.decode(chunk, { stream: true }))
      }
      yield* parser.push(decoder.decode())
      parser.finish()
    } finally {
      gunzip.destroy()
      fileStream.destroy()
    }
  }

  private async *pagesImpl(): AsyncGenerator<SourceRecord> {
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pages)
    )) {
      collectTags(row.tags, this.tagsSeen)
      yield row
    }
    this.pagesTagsCollected = true
  }

  pages(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pages() called before a successful connect().')
    }
    return this.pagesImpl()
  }

  private async *pageHistoryImpl(): AsyncGenerator<SourceRecord> {
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pageHistory)
    )) {
      collectTags(row.tags, this.tagsSeen)
      yield row
    }
    this.pageHistoryTagsCollected = true
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pageHistory() called before a successful connect().')
    }
    return this.pageHistoryImpl()
  }

  /**
   * There is no dedicated `tags.json`/`tags.json.gz` file in the export-bundle format at all (see
   * `ENTITY_FILES` above, and `2.5x-export-bundle-format.md`'s `pages`/`history` sections) — 2.x's
   * `tags`/`pageTags`/`pageHistoryTags` join is already denormalized inline as each page/history row's
   * own `tags: [{tag, title}]`. This derives a deduplicated tag list from that denormalized data —
   * but, unlike a plain second read, it does so via `this.tagsSeen`, which `pagesImpl()` and
   * `pageHistoryImpl()` above populate as a side effect of their own walk. A `tags()` call that
   * follows an already-completed `pages()`/`pageHistory()` walk (the order `phases/content.ts`'s
   * `contentPhase` drives them in) therefore reads neither file again; only a `tags()` call with no
   * prior walk of one (or both) of those files falls back to walking it here, for exactly the entity
   * that hasn't already been collected. Content-staging (Task 733's own `extractContentStaging`) does
   * not actually need to call this — it reads `tags` straight off each page/history row — but the
   * `SourceConnector` interface promises the generator, so it is implemented for real rather than left
   * throwing for a table this connector kind genuinely has no separate file for.
   */
  private async *tagsImpl(): AsyncGenerator<SourceRecord> {
    if (!this.pagesTagsCollected) {
      await drain(this.pagesImpl())
    }
    if (!this.pageHistoryTagsCollected) {
      await drain(this.pageHistoryImpl())
    }
    yield* this.tagsSeen.values()
  }

  tags(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('tags() called before a successful connect().')
    }
    return this.tagsImpl()
  }

  /**
   * `navigation.json` is one `{key: config}` object (2.x's `navigation` table reduced onto a single
   * JSON object by the exporter — see `2.5x-export-bundle-format.md`'s `navigation.json` section), not
   * an array of rows. Re-expands it back into `(key, config)` records, exactly as that doc's
   * "Implications" section calls for.
   */
  private async *navigationImpl(): AsyncGenerator<SourceRecord> {
    const filePath = path.join(this.bundlePath, ENTITY_FILES.navigation)
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return
    const parsed = await this.readJson(filePath)
    for (const [key, config] of Object.entries(parsed as Record<string, unknown>)) {
      yield { key, config }
    }
  }

  navigation(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('navigation() called before a successful connect().')
    }
    return this.navigationImpl()
  }

  settings(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('settings', 'Task 420 (Settings/Auth/Storage importer)')
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'Task 418 (Assets/Comments importer)')
  }
}
