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
 * Incrementally parses a UTF-8 byte stream whose top-level JSON value is an array, yielding each
 * element the instant its own closing boundary is read rather than waiting for the whole array (or
 * even the whole stream) to arrive. This is a minimal state machine over top-level structural
 * boundaries — string/escape tracking so a `,`/`}`/`]` inside a string value is never mistaken for a
 * structural one, plus a depth counter so only a *top-level* comma or closing bracket ends an
 * element — not a full JSON tokenizer, because it never has to interpret anything below one array
 * element: once an element's own text (object, array, string, number, boolean or null) is bounded,
 * that slice is handed to `JSON.parse` on its own. `filePath` is used only to phrase the
 * non-array-top-level error the same way the old whole-file parse did.
 */
async function* streamJsonArray(
  source: AsyncIterable<Buffer>,
  filePath: string
): AsyncGenerator<unknown> {
  type State = 'before-array' | 'before-element' | 'in-element' | 'after-element' | 'after-array'
  let state: State = 'before-array'
  let buffer = ''
  let elementStart = 0
  let depth = 0
  let inString = false
  let escapeNext = false

  const isWhitespace = (ch: string): boolean =>
    ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
  const notAnArrayError = (): Error =>
    new Error(`"${filePath}" does not contain a JSON array, as every 2.5.x entity file does.`)

  // Scan position into `buffer`, hoisted above the chunk loop rather than reset to 0 per chunk: a
  // chunk boundary can land mid-element (commonly mid-string), and restarting the scan from 0 would
  // re-walk already-consumed characters through the state machine a second time, double-toggling
  // stateful ones (`"`, `{`/`[`, `}`/`]`) and corrupting `inString`/`depth`.
  let i = 0
  for await (const chunk of source) {
    buffer += chunk.toString('utf8')
    while (i < buffer.length) {
      const ch = buffer[i]

      if (state === 'before-array') {
        if (isWhitespace(ch)) {
          i++
          continue
        }
        if (ch !== '[') throw notAnArrayError()
        state = 'before-element'
        i++
        continue
      }

      if (state === 'before-element') {
        if (isWhitespace(ch)) {
          i++
          continue
        }
        if (ch === ']') {
          state = 'after-array'
          i++
          continue
        }
        elementStart = i
        depth = 0
        inString = false
        escapeNext = false
        state = 'in-element'
        continue
      }

      if (state === 'in-element') {
        if (inString) {
          if (escapeNext) escapeNext = false
          else if (ch === '\\') escapeNext = true
          else if (ch === '"') inString = false
          i++
          continue
        }
        if (ch === '"') {
          inString = true
          i++
          continue
        }
        if (ch === '{' || ch === '[') {
          depth++
          i++
          continue
        }
        if (ch === '}' || ch === ']') {
          if (depth === 0) {
            // This bracket closes the enclosing array, not our element — the element itself was a
            // bare primitive (string/number/boolean/null) that just ended.
            yield JSON.parse(buffer.slice(elementStart, i))
            state = 'after-element'
            continue
          }
          depth--
          i++
          if (depth === 0) {
            yield JSON.parse(buffer.slice(elementStart, i))
            state = 'after-element'
          }
          continue
        }
        if (depth === 0 && ch === ',') {
          yield JSON.parse(buffer.slice(elementStart, i))
          state = 'after-element'
          continue
        }
        i++
        continue
      }

      if (state === 'after-element') {
        if (isWhitespace(ch)) {
          i++
          continue
        }
        if (ch === ',') {
          state = 'before-element'
          i++
          continue
        }
        if (ch === ']') {
          state = 'after-array'
          i++
          continue
        }
        throw new Error(`"${filePath}" has an unexpected character between JSON array elements.`)
      }

      // after-array: trailing whitespace or content past the closing bracket, ignored.
      i++
    }

    // Nothing before the current element's start is needed again — drop it so a large array never
    // accumulates the whole file in `buffer`, keeping peak memory bounded to one element at a time.
    // `i` is adjusted by the same amount (not reset) so the next chunk's scan resumes exactly where
    // this one left off, per the note above.
    if (state === 'in-element') {
      buffer = buffer.slice(elementStart)
      i -= elementStart
      elementStart = 0
    } else {
      buffer = ''
      i = 0
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
   * Streams one `.json.gz` entity file: `createReadStream` -> `zlib.createGunzip()` -> `
   * streamJsonArray`, so a row is yielded as soon as its own closing boundary is decompressed rather
   * than after the whole file has been read, decompressed and turned into one JS string first. That
   * matters because the old whole-file approach (`gunzipSync` + `.toString('utf8')` + `JSON.parse`)
   * could not read a `pages-history.json.gz` past V8's ~512 MB string ceiling at all —
   * `.toString('utf8')` throws outright above it — while this keeps peak memory bounded to whatever
   * is buffered for the row currently being read, not the entity file's full size.
   * Yields nothing, rather than throwing, when the file is absent — every export entity is
   * independently optional (a zero-row entity is skipped entirely, per `docs/migration/
   * 2.5x-export-bundle-format.md`), and a missing file is exactly that case, not an error. Throws the
   * same "does not contain a JSON array" error as before when the top-level value isn't an array.
   */
  private async *readGzipJsonArray(filePath: string): AsyncGenerator<SourceRecord> {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return
    const gunzip = createReadStream(filePath).pipe(zlib.createGunzip())
    for await (const row of streamJsonArray(gunzip, filePath)) {
      yield row as SourceRecord
    }
  }

  pages(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pages() called before a successful connect().')
    }
    return this.readGzipJsonArray(path.join(this.bundlePath, ENTITY_FILES.pages))
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    if (!this.connected) {
      throw new Error('pageHistory() called before a successful connect().')
    }
    return this.readGzipJsonArray(path.join(this.bundlePath, ENTITY_FILES.pageHistory))
  }

  /**
   * There is no dedicated `tags.json`/`tags.json.gz` file in the export-bundle format at all (see
   * `ENTITY_FILES` above, and `2.5x-export-bundle-format.md`'s `pages`/`history` sections) — 2.x's
   * `tags`/`pageTags`/`pageHistoryTags` join is already denormalized inline as each page/history row's
   * own `tags: [{tag, title}]`. This derives a deduplicated tag list the same way any other consumer
   * of this generator would have to: by scanning `pages()` and `pageHistory()` and collecting every
   * distinct tag string seen. Content-staging (Task 733's own `extractContentStaging`) does not
   * actually need to call this — it reads `tags` straight off each page/history row — but the
   * `SourceConnector` interface promises the generator, so it is implemented for real rather than left
   * throwing for a table this connector kind genuinely has no separate file for.
   */
  private async *tagsImpl(): AsyncGenerator<SourceRecord> {
    const seen = new Map<string, SourceRecord>()
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pages)
    )) {
      collectTags(row.tags, seen)
    }
    for await (const row of this.readGzipJsonArray(
      path.join(this.bundlePath, ENTITY_FILES.pageHistory)
    )) {
      collectTags(row.tags, seen)
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
