import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { parseModuleProps } from '../helpers/common.ts'
import type { ModuleProp } from '../helpers/common.ts'

/**
 * The provider every site starts on: comments stored and rendered by this wiki's own database, with
 * no external service involved. It is the only provider guaranteed to work without any configuration.
 */
const DEFAULT_MODULE = 'default'

/**
 * A comment provider module, as declared by its `definition.yml`.
 *
 * `icon`/`vendor` (the `default` provider's own fields) and `author`/`logo` (used by every external
 * provider — Disqus, Commento, Artalk) are both optional rather than unified into one shape: the two
 * kinds of provider were scaffolded from different sources (2.5.x's native module vs. its external
 * ones) and forcing them onto a single required field each would mean inventing a value neither
 * `definition.yml` actually declares.
 */
export interface CommentProviderDefinition {
  key: string
  title: string
  description: string
  icon?: string
  vendor?: string
  author?: string
  logo?: string
  website: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
  /**
   * Whether this provider embeds a vendor's own client-side script/widget (Disqus, Commento, Artalk)
   * rather than being rendered and moderated server-side by this wiki. Read straight off
   * `definition.yml`; defaults to `false` when absent, matching the `default` provider — which has
   * real server-side render/spam/rate-limit logic (see `modules/comments/default/comments.ts`) and so
   * declares no `codeTemplate` at all.
   */
  codeTemplate: boolean
  /**
   * Whether a `comments.ts` sits next to the definition, i.e. whether this provider has server-side
   * code behind it. Only the `default` provider does today — every external provider is pure
   * client-side configuration (a shortname/instance URL passed to the vendor's own embed script), so
   * it never needs one. Mirrors `StorageDefinition.hasImplementation` in `models/storage.ts`, but see
   * `isSelectable()` below for why comment providers cannot be gated on this field alone the way
   * storage targets currently are.
   */
  hasImplementation: boolean
}

/**
 * Comments model
 *
 * Loads the comment provider modules declared under `modules/comments/<key>/definition.yml` — the
 * `default` provider (server-rendered, this wiki's own database) plus any external one (Disqus,
 * Commento, Artalk, ...). Mirrors the `StorageDefinition`/`refreshFromDisk()` pattern in
 * `models/storage.ts`.
 */
class Comments {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: CommentProviderDefinition[] = []

  /**
   * Load the comment provider module definitions from disk.
   */
  async refreshFromDisk(): Promise<void> {
    const commentsPath = path.join(WIKI.SERVERPATH, 'modules/comments')
    const definitions: CommentProviderDefinition[] = []
    try {
      for (const dir of await fs.readdir(commentsPath)) {
        const raw = await fs.readFile(path.join(commentsPath, dir, 'definition.yml'), 'utf8')
        const parsed = load(raw) as Record<string, any>
        // -> The directory name is the key, as it is for every other module type
        parsed.key = dir
        // -> Props carry a display `order`, applied once here so that every consumer reads them in
        //    the order the module meant them to be shown in
        parsed.props = Object.fromEntries(
          Object.entries(parseModuleProps(parsed.props ?? {})).sort(
            ([, a], [, b]) => a.order - b.order
          )
        )
        // -> Absent in YAML means "not a client-side embed", i.e. false — only ever `true` when the
        //    module says so explicitly
        parsed.codeTemplate = parsed.codeTemplate === true
        parsed.hasImplementation = await this.hasImplementation(dir)
        definitions.push(parsed as CommentProviderDefinition)
      }
      // -> The native provider first, then alphabetically: it is the one every site starts with
      this.definitions = definitions.sort((a, b) =>
        a.key === DEFAULT_MODULE
          ? -1
          : b.key === DEFAULT_MODULE
            ? 1
            : a.title.localeCompare(b.title)
      )
      WIKI.logger.info(`Found ${this.definitions.length} comment provider modules [ OK ]`)
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.error(
        `Could not read the comment provider definitions at ${commentsPath} [ FAILED ]`
      )
      WIKI.logger.error(err.message)
    }
  }

  /**
   * Whether the module has any server-side code to run, as opposed to only a definition.
   */
  async hasImplementation(key: string): Promise<boolean> {
    try {
      await fs.access(path.join(WIKI.SERVERPATH, 'modules/comments', key, 'comments.ts'))
      return true
    } catch {
      return false
    }
  }

  /**
   * A single definition, or null when nothing on disk declares that key.
   */
  getDefinition(key: string): CommentProviderDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Whether a provider may be listed and selected.
   *
   * Deliberately **not** `hasImplementation` alone: `models/storage.ts` gates a storage target's
   * actions on that field, which happens to be harmless there only because no storage module has
   * shipped an implementation yet, so every target is equally unavailable. A comment provider is a
   * different shape entirely — Disqus, Commento and Artalk are pure client-side embeds (a shortname
   * or instance URL handed to the vendor's own script) and were never going to get a `comments.ts`,
   * so gating on `hasImplementation` the same way would mark them permanently unselectable instead of
   * temporarily unavailable. `codeTemplate` is the independent signal that a provider needs no
   * server-side implementation to be usable.
   */
  isSelectable(definition: CommentProviderDefinition): boolean {
    return definition.hasImplementation || definition.codeTemplate
  }

  /**
   * Every definition, shaped the way a REST endpoint hands it to the frontend: `hasImplementation`
   * and `codeTemplate` both travel so the admin area can tell a "native, server-rendered" provider
   * (`default`) apart from an "external, client-only" one (Disqus/Commento/Artalk), and `isSelectable`
   * is included pre-computed rather than left for the frontend to re-derive the same OR.
   */
  getDefinitions(): Array<CommentProviderDefinition & { isSelectable: boolean }> {
    return this.definitions.map((definition) => ({
      ...definition,
      isSelectable: this.isSelectable(definition)
    }))
  }
}

export const comments = new Comments()
