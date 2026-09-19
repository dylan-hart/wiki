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

/** Accepts both shapes a row's `tags` can arrive in — `[{tag, title}]` or an already-plain
 * `string[]` — and keys `seen` by tag string, so a tag appearing on many pages is kept once. */
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
 * never holding more than the current in-flight object plus a small unconsumed tail. Walks the
 * `{`/`}`/`,` boundaries, tracking string/escape state so a brace or comma inside a quoted value is
 * never mistaken for a structural one, and bracket depth so a nested array/object inside a row (e.g.
 * `tags: [...]`) does not end the row early.
 *
 * Exported beyond `readGzipJsonArray`'s own use of it so the incremental-yield behavior has a
 * deterministic unit test independent of OS-level stream chunk sizing.
 */
export class JsonArrayStreamParser {
  private readonly filePath: string
  private buffer = ''
  /** Index into `buffer` of the next character to scan, persisted across `push()` calls: rescanning
   * characters after a chunk boundary landed mid-object would double-count their effect on
   * `depth`/`inString`. */
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

  *push(chunk: string): Generator<SourceRecord> {
    this.buffer += chunk
    let i = this.pos
    while (i < this.buffer.length) {
      const ch = this.buffer[i]

      if (this.sawCloseBracket) {
        // Past the array's own `]`: advance over trailing whitespace or junk rather than
        // reinterpreting it as more array content.
        i++
        continue
      }

      if (this.objectStart === -1) {
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
    // Keep only the unconsumed tail — a row object still mid-scan — never the whole buffer seen so
    // far, and re-anchor `pos` to it.
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

/** Every entity is independently optional: a bundle exported with only a subset of them checked is a
 * complete, valid bundle for that subset (`docs/migration/2.5x-export-bundle-format.md`). */
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

/**
 * Opens a directory produced by 2.5.x's "Export to disk" system utility. `connect()` parses and
 * shape-checks the three small, ungzipped files (`settings.json`, `navigation.json`, `groups.json`)
 * against `2.5x-export-bundle-format.md` to prove the format assumption every generator here depends
 * on, but deliberately keeps none of what it parsed: `navigation()` re-reads and re-parses its file,
 * so the validation pass and an entity generator's real read stay independent.
 */
export class ExportBundleSourceConnector implements SourceConnector {
  readonly kind = 'export-bundle' as const

  private readonly bundlePath: string
  private notes: string[] = []
  private detectedVersion: string | undefined
  private connected = false

  /**
   * Tags collected as a side effect of a `pages()`/`pageHistory()` walk, so `tagsImpl()` need not
   * decompress and re-parse the bundle's two largest files — `phases/content.ts` already walks both
   * before it ever calls `tags()`. Populated only once the corresponding generator's loop actually
   * finishes: a caller that abandons it partway (an early `break`) leaves the field `null`, and
   * `tagsImpl()` falls back to reading that file directly.
   */
  private tagsFromPages: Map<string, SourceRecord> | null = null
  private tagsFromPageHistory: Map<string, SourceRecord> | null = null

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

    // Only the three small, ungzipped files — connecting never touches the large gzipped ones.

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
        // `redirectOnLogin` was added in 2.5.12 — the minimum-version signal
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
   * Feeds the gunzip stream chunk by chunk into a `JsonArrayStreamParser`, so a row is yielded as
   * soon as its own closing `}` arrives and peak memory stays bounded to one row plus a small tail.
   * Reading and decompressing the whole file instead holds the entire decompressed array as one JS
   * string, which throws past V8's ~512 MB ceiling — reachable by a large `pages-history.json.gz`.
   *
   * Yields nothing, rather than throwing, when the file is absent: every export entity is
   * independently optional, so a missing file is a zero-row entity, not an error.
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
    const seen = new Map<string, SourceRecord>()
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pages)
    )) {
      collectTags(row.tags, seen)
      yield row
    }
    this.tagsFromPages = seen
  }

  private async *pageHistoryImpl(): AsyncGenerator<SourceRecord> {
    const seen = new Map<string, SourceRecord>()
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pageHistory)
    )) {
      collectTags(row.tags, seen)
      yield row
    }
    this.tagsFromPageHistory = seen
  }

  pages(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pages() called before a successful connect().')
    }
    return this.pagesImpl()
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pageHistory() called before a successful connect().')
    }
    return this.pageHistoryImpl()
  }

  /**
   * The export-bundle format has no dedicated tags file at all — 2.x's `tags`/`pageTags`/
   * `pageHistoryTags` join is already denormalized inline as each page/history row's own
   * `tags: [{tag, title}]` — so this derives a deduplicated list from that instead.
   *
   * Merge order is load-bearing: pages' entries (and their titles) win over history's for a tag seen
   * in both, matching the un-cached scan's own ordering.
   */
  private async *tagsImpl(): AsyncGenerator<SourceRecord> {
    const seen = new Map<string, SourceRecord>()
    if (this.tagsFromPages) {
      for (const [tag, record] of this.tagsFromPages) seen.set(tag, record)
    } else {
      for await (const row of this.readGzipJsonArray(
        path.join(this.bundlePath, ENTITY_FILES.pages)
      )) {
        collectTags(row.tags, seen)
      }
    }
    if (this.tagsFromPageHistory) {
      for (const [tag, record] of this.tagsFromPageHistory) {
        if (!seen.has(tag)) seen.set(tag, record)
      }
    } else {
      for await (const row of this.readGzipJsonArray(
        path.join(this.bundlePath, ENTITY_FILES.pageHistory)
      )) {
        collectTags(row.tags, seen)
      }
    }
    yield* seen.values()
  }

  tags(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('tags() called before a successful connect().')
    }
    return this.tagsImpl()
  }

  /**
   * `navigation.json` is one `{key: config}` object — the exporter reduces 2.x's `navigation` table
   * onto it — not an array of rows, so this re-expands it back into `(key, config)` records.
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

  comments(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError(
      'comments',
      'a future task extending the export-bundle connector'
    )
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'Task 418 (Assets/Comments importer)')
  }
}
