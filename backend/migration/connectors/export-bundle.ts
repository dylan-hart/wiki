import fs from 'node:fs/promises'
import path from 'node:path'
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
 * The bulk, batched/gzipped files (`users.json.gz`, `pages.json.gz`, `pages-history.json.gz`,
 * `comments.json.gz`) are never opened here: reading and transforming those rows is explicitly
 * deferred to the tasks that own each entity (see each generator's `NotYetImplementedError`), which
 * is also why `groups()`/`navigation()`/`settings()` remain stubs even though `connect()` already
 * parsed their files once for validation — that parsed data is not retained or exposed as rows here.
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

  pages(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('pages', 'Task 416 (Content importer)')
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('pageHistory', 'Task 416 (Content importer)')
  }

  tags(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('tags', 'Task 416 (Content importer)')
  }

  navigation(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('navigation', 'Task 420 (Settings/Auth/Storage importer)')
  }

  settings(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('settings', 'Task 420 (Settings/Auth/Storage importer)')
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'Task 418 (Assets/Comments importer)')
  }
}
