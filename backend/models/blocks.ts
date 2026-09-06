import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { CustomError, isUniqueViolation } from '../helpers/common.ts'
import {
  blockCode as blockCodeTable,
  blocks as blocksTable,
  sites as sitesTable
} from '../db/schema.ts'

/** One authorable attribute of a block, as its `static definition` describes it. */
export interface BlockProp {
  name: string
  type: 'string' | 'number' | 'boolean' | 'select'
  label?: string
  hint?: string
  required?: boolean
  options?: string[]
  default?: string | number | boolean
}

/** A block as declared by its component's `static definition`. */
export interface BlockDefinition {
  block: string
  name: string
  description: string
  icon: string
  props?: BlockProp[]
  /**
   * Site-level fields an admin sets once for the whole site, as opposed to `props`, which an author
   * sets per use in the editor. Same shape as `props`, reused rather than duplicated: a tile server
   * URL or an API key is exactly the same kind of field, just filled in by a different person in a
   * different place (the admin area's block config, not the editor's block picker).
   */
  config?: BlockProp[]
  /**
   * A block that only ever appears inside another one, such as a single tab of a set of tabs.
   *
   * It is never registered for a site: not something to insert on its own, and not something to
   * switch off separately from its parent. It is still declared here, because that is what lets its
   * tag and attributes survive a page being saved.
   */
  isChild?: boolean
  /** Body the editor writes between the opening and closing lines when inserting the block. */
  template?: string
}

/** A block row as exposed by the API, with what its component says it can be given. */
export interface SiteBlock {
  id: string
  block: string
  name: string
  description: string
  icon: string
  isEnabled: boolean
  isCustom: boolean
  config: Record<string, any>
  configFields: BlockProp[]
  props: BlockProp[]
  template: string
  /** The custom element name this block renders as -- always `block-{block}`. */
  elementTag: string
}

const blockSelection = {
  id: blocksTable.id,
  block: blocksTable.block,
  name: blocksTable.name,
  description: blocksTable.description,
  icon: blocksTable.icon,
  isEnabled: blocksTable.isEnabled,
  isCustom: blocksTable.isCustom,
  config: blocksTable.config,
  // -> Raw column reads, only meaningful for a custom row — kept off `SiteBlock` under their own
  //    names so `getSiteBlocks()` below can pick a source (this row, or the manifest) per block
  //    without a built-in's empty defaults colliding with the field names it maps them onto.
  customProps: blocksTable.props,
  customTemplate: blocksTable.template
}

/**
 * Blocks model
 *
 * Built-in blocks live in the `blocks/` workspace, one directory per block. Their metadata is
 * declared as a `static definition` on each Lit component and collected into
 * `blocks/compiled/blocks.manifest.json` by the rollup build, which is what this model reads —
 * the components themselves cannot be imported outside a browser.
 */
class Blocks {
  /** Definitions read from the compiled manifest, refreshed by `refreshFromDisk()`. */
  definitions: BlockDefinition[] = []

  /**
   * Whether the last read of the manifest succeeded.
   *
   * Told apart from "the manifest lists nothing", because the two mean opposite things to a sync: an
   * empty manifest says every built-in block has been removed, a missing one says nothing at all.
   */
  private manifestLoaded = false

  /**
   * Load the built-in block definitions from the compiled manifest.
   *
   * Read on every boot, so a block whose name, description or icon changed on disk is picked up by
   * restarting the server — `syncAllSites` is what writes the difference to each site.
   *
   * A missing manifest is not fatal: `blocks/compiled` is a build output and is not in the
   * repository, so a fresh checkout has none until `npm run build` has been run in `blocks/`.
   */
  async refreshFromDisk(): Promise<void> {
    const manifestPath = path.join(WIKI.ROOTPATH, 'blocks/compiled/blocks.manifest.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (!Array.isArray(manifest)) {
        throw new TypeError('Manifest is not an array.')
      }
      this.definitions = manifest
      this.manifestLoaded = true
      WIKI.logger.debug('blocks', 'loaded the manifest', { blocks: this.definitions.length })
      await this.warnIfStale(manifestPath)
    } catch (err: any) {
      this.definitions = []
      this.manifestLoaded = false
      WIKI.logger.warn('blocks', 'could not read the manifest, run "npm run build" in blocks/', {
        path: manifestPath,
        error: err
      })
    }
  }

  /**
   * Say so when the manifest is older than the components it was built from.
   *
   * The manifest is a build output, and nothing rebuilds it on the way in here — so editing a block
   * and restarting the server looks like the change was ignored, when what happened is that the
   * server read a manifest describing the previous version of the block.
   *
   * Only in a source tree: a packaged instance ships `blocks/compiled` without the sources beside it,
   * where there is nothing to compare against and nothing anybody could rebuild.
   */
  private async warnIfStale(manifestPath: string): Promise<void> {
    try {
      const sourcePath = path.join(WIKI.ROOTPATH, 'blocks')
      const builtAt = (await stat(manifestPath)).mtimeMs
      const entries = await readdir(sourcePath, { withFileTypes: true })
      const stale: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('block-')) {
          continue
        }
        const component = path.join(sourcePath, entry.name, 'component.js')
        const changedAt = await stat(component).then(
          (info) => info.mtimeMs,
          () => 0
        )
        if (changedAt > builtAt) {
          stale.push(entry.name)
        }
      }
      if (stale.length > 0) {
        WIKI.logger.warn(
          'blocks',
          'changed since the manifest was built — run "npm run build" in blocks/ and restart to pick that up',
          { blocks: stale.join(', ') }
        )
      }
    } catch {
      // -> No sources to compare against, which is the normal state of a packaged instance
    }
  }

  /**
   * Bring a site's block rows in line with what is installed on disk.
   *
   * Registers what is missing, writes back a name, description or icon that changed, and drops rows
   * for built-ins that are no longer there. `isEnabled` and `config` are the site's own and are never
   * touched — which is why an existing row is updated rather than replaced.
   *
   * Custom blocks are left alone entirely: they have no on-disk counterpart to compare against.
   *
   * @returns How many rows were added, changed and removed
   */
  async syncSite(siteId: string): Promise<{ added: number; updated: number; removed: number }> {
    const existing = await WIKI.db
      .select({
        block: blocksTable.block,
        name: blocksTable.name,
        description: blocksTable.description,
        icon: blocksTable.icon
      })
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.isCustom, false)))
    // -> Child blocks are part of their parent, so they get no row of their own — and a block that
    //    becomes one is cleaned up by the orphan pass below, since it is no longer a defined key
    const registrable = this.definitions.filter((d) => !d.isChild)
    const definedKeys = registrable.map((d) => d.block)
    let added = 0
    let updated = 0

    for (const definition of registrable) {
      const row = existing.find((entry: any) => entry.block === definition.block)
      if (!row) {
        // -> `onConflictDoNothing` rather than a plain insert: this runs from `syncAllSites()` at
        //    every instance's boot, so two instances syncing the same site concurrently both read
        //    `existing` with nothing there and both reach this insert. Without the conflict target
        //    the second write would 23505 on `blocks_composite_idx` and abort `postBoot()`; with it,
        //    the loser silently no-ops and the row it would have written is already there.
        const [inserted] = await WIKI.db
          .insert(blocksTable)
          .values({
            siteId,
            block: definition.block,
            name: definition.name,
            description: definition.description,
            icon: definition.icon,
            isEnabled: true,
            isCustom: false,
            config: {}
          })
          .onConflictDoNothing({ target: [blocksTable.siteId, blocksTable.block] })
          .returning({ id: blocksTable.id })
        if (inserted) {
          added++
        }
        continue
      }
      // -> Written only when it would change something, so that a boot that found nothing new is a
      //    boot that wrote nothing — and the count below means what it says
      if (
        row.name !== definition.name ||
        row.description !== definition.description ||
        row.icon !== definition.icon
      ) {
        await WIKI.db
          .update(blocksTable)
          .set({
            name: definition.name,
            description: definition.description,
            icon: definition.icon
          })
          .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.block, definition.block)))
        updated++
      }
    }

    // -> A built-in that has been removed from disk should not linger in the admin list
    const orphaned = existing
      .map((entry: any) => entry.block)
      .filter((key: string) => !definedKeys.includes(key))
    if (orphaned.length > 0) {
      await WIKI.db
        .delete(blocksTable)
        .where(
          and(
            eq(blocksTable.siteId, siteId),
            eq(blocksTable.isCustom, false),
            inArray(blocksTable.block, orphaned)
          )
        )
    }

    return { added, updated, removed: orphaned.length }
  }

  /**
   * Register the built-in blocks for every site. Called at boot, after the sites cache is loaded.
   *
   * Skipped outright when the manifest could not be read, rather than run against an empty list of
   * definitions: that would read as "every built-in block has been uninstalled" and delete each
   * site's rows, taking which blocks it had switched on with them.
   */
  async syncAllSites(): Promise<void> {
    if (!this.manifestLoaded) {
      WIKI.logger.warn('blocks', 'skipping registration, the manifest could not be read')
      return
    }
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    const total = { added: 0, updated: 0, removed: 0 }
    for (const site of sites) {
      const counts = await WIKI.models.blocks.syncSite(site.id)
      total.added += counts.added
      total.updated += counts.updated
      total.removed += counts.removed
    }
    WIKI.logger.info('blocks', 'registered blocks', { sites: sites.length })
    if (total.added || total.updated || total.removed) {
      WIKI.logger.info('blocks', 'blocks changed on disk', {
        added: total.added,
        updated: total.updated,
        removed: total.removed
      })
    }
  }

  /**
   * Fetch the blocks available to a site, built-in first, then by name
   */
  async getSiteBlocks(siteId: string): Promise<SiteBlock[]> {
    const results = await WIKI.db
      .select(blockSelection)
      .from(blocksTable)
      .where(eq(blocksTable.siteId, siteId))
      .orderBy(blocksTable.isCustom, blocksTable.name)
    /*
      A built-in block's `props`/`configFields`/`template` come from the manifest rather than the row:
      they describe the component's own attributes, so they belong to the installed code and not to a
      site's copy of it. Reading them here means an updated block's fields are correct the moment it is
      deployed, with nothing to migrate.

      A custom block has no manifest entry — it is not installed code, it is what was uploaded — so it
      sources `props`/`template` from its own row instead, written when it was uploaded/edited, and
      reports no `configFields` at all: the admin-config-field-schema concept only applies to a block
      with a manifest to declare one, so a custom block's `config` is written as given (see
      `sanitizeConfig()` below). `elementTag` is always `block-{block}` for both kinds — a custom
      block's upload is rejected (`api/blocks.ts`) unless its code actually registers that exact tag,
      so there is no override to source from a row.
    */
    type RawRow = SiteBlock & {
      customProps: BlockProp[]
      customTemplate: string
    }
    return (results as RawRow[]).map(({ customProps, customTemplate, ...row }) => {
      if (row.isCustom) {
        return {
          ...row,
          props: customProps ?? [],
          configFields: [],
          template: customTemplate ?? '',
          elementTag: `block-${row.block}`
        }
      }
      const definition = this.definitions.find((d) => d.block === row.block)
      return {
        ...row,
        props: definition?.props ?? [],
        configFields: definition?.config ?? [],
        template: definition?.template ?? '',
        elementTag: `block-${row.block}`
      }
    })
  }

  /**
   * A site's custom blocks, in just the shape `blockAllowances()` (`helpers/htmlSanitizePolicy.ts`) needs to
   * admit them to the sanitizer's per-block allowlist: the tag they register under and the prop names
   * a saved page may put on them.
   *
   * Every custom row, not only enabled ones — `blockAllowances()` already has `getEnabledKeys()`'s
   * answer and applies that filter itself, the same way it does for the built-in half of the same
   * list; duplicating the filter here would just be a second copy of the same rule that could disagree
   * with the first.
   *
   * Prop names are trusted here without a second check: `helpers/blockDefinition.ts#extractBlockDefinition()`
   * is what actually stands between an uploaded prop name and the sanitizer's attribute allowlist
   * (`/^[a-z][a-z0-9-]*$/`, rejecting anything shaped like a `*`-glob or an `on*` inline-handler name at
   * upload time) — this method is a plain read, not a second gate.
   */
  async getCustomBlockDefinitions(
    siteId: string
  ): Promise<{ block: string; props: BlockProp[] }[]> {
    const rows = await WIKI.db
      .select({ block: blocksTable.block, props: blocksTable.props })
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.isCustom, true)))
    return rows.map((row) => ({ block: row.block, props: (row.props as BlockProp[]) ?? [] }))
  }

  /**
   * The keys of the blocks a site has switched on.
   *
   * Read from the database on every call rather than kept in a cache like this model's definitions.
   * What this answer gates is which blocks survive a page being saved, and a stale `false` silently
   * strips an author's block out of their page — a wrong answer here destroys content rather than
   * merely showing the wrong list. One indexed read of a handful of rows, on a path that has just
   * sanitised a whole document, is not worth that risk.
   *
   * Child blocks never appear: they have no row of their own, and follow the block they sit in.
   */
  async getEnabledKeys(siteId: string): Promise<Set<string>> {
    const rows = await WIKI.db
      .select({ block: blocksTable.block })
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.isEnabled, true)))
    return new Set(rows.map((row) => row.block))
  }

  /**
   * Strip a config object down to the keys a block still declares.
   *
   * `blockKey` is looked up from the row rather than trusted from the request body, since the point
   * of this pass is that the caller cannot assert its way past it: a block's `config` field list can
   * change shape between deploys (a field renamed, or dropped entirely), and without this a key left
   * over from a previous shape would sit in the row forever — nothing else ever removes it, and the
   * admin form generated from the current `configFields` has no way to show or clear a key it no
   * longer knows about.
   *
   * A custom block is passed through untouched: it has no manifest declaration to check `config`
   * against in the first place (see `getSiteBlocks()`'s `configFields: []` for the same reason), so
   * there is nothing here to strip it down to.
   *
   * Deliberately loose beyond that: values are written as given, with no per-field type check against
   * `BlockProp.type`. This mirrors how page-authored `props` are already trusted — `blockAllowances()`
   * in `helpers/htmlSanitizePolicy.ts` allow-lists an embedded block's attributes by name only, taking whatever
   * string value came with them — so `config` is held to the same standard as the sibling data an
   * admin's site-level form and an author's page-level markup both ultimately feed into the same
   * component. This was a deliberate choice for new code, not a preserved pre-existing gap, with one
   * exception carved out since: `assertValidConfig()` below, for exactly the case that comment called
   * out as worth revisiting — a config value trusted for more than passing through to its own
   * component, because something here now fetches it server-side.
   */
  private sanitizeConfig(
    block: { key: string; isCustom: boolean } | undefined,
    config: Record<string, any>
  ): Record<string, any> {
    if (!block || block.isCustom) {
      return config
    }
    const definition = this.definitions.find((d) => d.block === block.key)
    const declared = new Set((definition?.config ?? []).map((field) => field.name))
    const sanitized = Object.fromEntries(
      Object.entries(config).filter(([key]) => declared.has(key))
    )
    this.assertValidConfig(block.key, sanitized)
    return sanitized
  }

  /**
   * The one config value this file actually revisits the "no per-field validation" note above for:
   * block-plantuml's `server` is fetched server-side by `DiagramRender#renderPlantuml`
   * (`models/diagramRender.ts`, OpenProject task 2223), unlike every other block's config, which is
   * only ever handed to that block's own client-side component. A bad value here is not a rendering
   * inconvenience an author would notice and fix — left unchecked, it is exactly the SSRF this block's
   * config field exists to close off (OpenProject epic 2216), so it is refused at the one point a
   * caller can still be turned away: when an admin writes it, not when a reader's request later makes
   * this model fetch whatever was stored.
   *
   * Empty is left alone (falls back to the public default); anything else must parse as a URL, be
   * `http:`/`https:`, and carry neither a query string nor a fragment — a query string is what let the
   * old caller-supplied override fold `/${format}/${encoded}` into itself and reach an arbitrary path
   * on an otherwise-fine host (see `diagramRender.ts`'s `plantumlUrl()`).
   */
  private assertValidConfig(blockKey: string, config: Record<string, any>): void {
    if (blockKey !== 'plantuml') {
      return
    }
    const value = config.server
    if (typeof value !== 'string' || value.trim() === '') {
      return
    }
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new CustomError('blocksInvalidConfig', `"${value}" is not a valid URL.`, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CustomError(
        'blocksInvalidConfig',
        `The PlantUML server must be an http:// or https:// URL, not "${parsed.protocol}".`,
        400
      )
    }
    if (parsed.search || parsed.hash) {
      throw new CustomError(
        'blocksInvalidConfig',
        'The PlantUML server URL may not contain a query string or fragment.',
        400
      )
    }
  }

  /**
   * Enable or disable blocks in bulk, optionally updating each one's site-level `config`.
   *
   * A state with no `config` writes only `isEnabled`, leaving the row's existing config untouched —
   * batched with `inArray`. A state that does carry `config` needs its own `UPDATE`, since a differing
   * JSONB value per row cannot be expressed as one batched write; that config is sanitized first via
   * `sanitizeConfig`, keyed by the row's own `block`/`isCustom` (fetched up front, since the request
   * only carries the row id).
   *
   * `config` is left untouched, not cleared, when the caller omits it for a state entry — an empty
   * object `{}` is a deliberate "clear whatever was set", not the same as "say nothing about it".
   *
   * Deliberately does not queue a re-render of pages that already embed a block moved to disabled here
   * — see `helpers/htmlSanitizePolicy.ts#blockAllowances`'s doc comment (OpenProject #1738) for why, and for what
   * keeps a disabled block from reaching a reader in the meantime regardless.
   *
   * @param states Block IDs with their desired state, and optionally a new site-level config
   * @returns The number of block rows written — a block already in the requested state still counts
   */
  async setBlocksState(
    siteId: string,
    states: { id: string; isEnabled: boolean; config?: Record<string, any> }[]
  ): Promise<number> {
    let changed = 0

    const ids = states.map((s) => s.id)
    const rows =
      ids.length > 0
        ? await WIKI.db
            .select({
              id: blocksTable.id,
              block: blocksTable.block,
              isCustom: blocksTable.isCustom
            })
            .from(blocksTable)
            .where(and(eq(blocksTable.siteId, siteId), inArray(blocksTable.id, ids)))
        : []
    const blockById = new Map(
      rows.map((row) => [row.id, { key: row.block, isCustom: row.isCustom }])
    )

    for (const isEnabled of [true, false]) {
      const group = states.filter((s) => s.isEnabled === isEnabled)
      if (group.length < 1) {
        continue
      }

      const withoutConfig = group.filter((s) => s.config === undefined).map((s) => s.id)
      if (withoutConfig.length > 0) {
        const result = await WIKI.db
          .update(blocksTable)
          .set({ isEnabled })
          .where(and(eq(blocksTable.siteId, siteId), inArray(blocksTable.id, withoutConfig)))
        changed += result.rowCount ?? 0
      }

      for (const state of group) {
        if (state.config === undefined) {
          continue
        }
        const config = this.sanitizeConfig(blockById.get(state.id), state.config)
        const result = await WIKI.db
          .update(blocksTable)
          .set({ isEnabled, config })
          .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.id, state.id)))
        changed += result.rowCount ?? 0
      }
    }
    return changed
  }

  /**
   * Fetch a custom block's compiled component code, by id — for the route that serves it to the
   * browser.
   *
   * Scoped to `siteId` and `isCustom` the same way `deleteCustomBlock()` is: a block id alone is not
   * enough to say a caller may have it, and a built-in has no row in `blockCode` to find anyway.
   *
   * @returns The code bytes, or `undefined` if there is no such custom block on this site
   */
  async getCustomBlockCode(siteId: string, id: string): Promise<Buffer | undefined> {
    const [row] = await WIKI.db
      .select({ code: blockCodeTable.code })
      .from(blockCodeTable)
      .innerJoin(blocksTable, eq(blockCodeTable.blockId, blocksTable.id))
      .where(
        and(eq(blocksTable.siteId, siteId), eq(blocksTable.id, id), eq(blocksTable.isCustom, true))
      )
    return row?.code
  }

  /**
   * Whether a tag is already spoken for on a site, by a built-in block or by another custom one.
   *
   * A block's tag becomes `<block-{tag}>` in a rendered page, so two blocks answering to the same one
   * would silently shadow one with the other rather than fail loudly — this is what the upload route
   * checks before registering a custom block, so that collision is rejected instead.
   *
   * The built-in half is answered from the in-memory manifest (`this.definitions`) rather than a
   * query: a site's built-in rows are always exactly what `syncSite()` last wrote from it, so it is
   * the manifest that is authoritative, not the copy in `blocks`. Only the custom half needs the
   * database, since that is the one kind of row with no on-disk source of truth.
   */
  async isTagTaken(siteId: string, tag: string): Promise<boolean> {
    if (this.definitions.some((d) => d.block === tag)) {
      return true
    }
    const [row] = await WIKI.db
      .select({ id: blocksTable.id })
      .from(blocksTable)
      .where(
        and(
          eq(blocksTable.siteId, siteId),
          eq(blocksTable.isCustom, true),
          eq(blocksTable.block, tag)
        )
      )
    return Boolean(row)
  }

  /**
   * Register a newly-uploaded custom block: a `blocks` row plus its compiled code, written together
   * so a failure partway through never leaves one without the other.
   *
   * `isEnabled` defaults to `true`, the same as a built-in gets on first sync (`syncSite()` above) — a
   * block an administrator just uploaded is one they meant to make available, not one to leave hidden
   * behind a second step.
   *
   * Callers are expected to have already resolved the tag collision with `isTagTaken()`, which this
   * still races against: two uploads for the same tag can both pass that check and both reach this
   * insert, so `blocks_composite_idx` is what actually decides the winner. The loser's `23505` is
   * surfaced as a 409 `CustomError` rather than an unhandled raw error.
   *
   * @param definition The block's own static definition, as `helpers/blockDefinition.ts` extracted it.
   * @param code The uploaded `component.js` source, stored verbatim for `getCustomBlockCode()` to serve back.
   */
  async createCustomBlock(
    siteId: string,
    definition: BlockDefinition,
    code: Buffer
  ): Promise<SiteBlock> {
    return WIKI.db.transaction(async (tx) => {
      let row
      try {
        ;[row] = await tx
          .insert(blocksTable)
          .values({
            siteId,
            block: definition.block,
            name: definition.name,
            description: definition.description,
            icon: definition.icon,
            isEnabled: true,
            isCustom: true,
            props: definition.props ?? [],
            template: definition.template ?? ''
          })
          .returning()
      } catch (err: any) {
        if (isUniqueViolation(err)) {
          throw new CustomError(
            'blockTagTaken',
            `A block already registers the tag "block-${definition.block}" on this site.`,
            409
          )
        }
        throw err
      }
      await tx.insert(blockCodeTable).values({ blockId: row!.id, code })
      return {
        id: row!.id,
        block: row!.block,
        name: row!.name,
        description: row!.description,
        icon: row!.icon,
        isEnabled: row!.isEnabled,
        isCustom: row!.isCustom,
        config: row!.config as Record<string, any>,
        configFields: [],
        props: (row!.props as BlockProp[]) ?? [],
        template: row!.template,
        elementTag: `block-${row!.block}`
      }
    })
  }

  /**
   * Delete a custom block. Built-in blocks are rejected, since the next sync would recreate them.
   *
   * Removes its stored code along with the row itself — `blockCode` is a separate table (see
   * `db/schema.ts`), so deleting `blocks` alone would leave the code behind as an orphan. Done inside
   * a transaction, code first, so this method is what is actually responsible for the code going away
   * rather than depending on the foreign key's `onDelete: 'cascade'` (kept as a safety net for a row
   * reached some other way, not as a substitute for cleaning it up here).
   *
   * @returns Whether a block was deleted
   */
  async deleteCustomBlock(siteId: string, id: string): Promise<boolean> {
    return WIKI.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: blocksTable.id })
        .from(blocksTable)
        .where(
          and(
            eq(blocksTable.siteId, siteId),
            eq(blocksTable.id, id),
            eq(blocksTable.isCustom, true)
          )
        )
      if (!row) {
        return false
      }
      await tx.delete(blockCodeTable).where(eq(blockCodeTable.blockId, row.id))
      await tx.delete(blocksTable).where(eq(blocksTable.id, row.id))
      return true
    })
  }
}

export const blocks = new Blocks()
