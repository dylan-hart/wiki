import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { blocks as blocksTable, sites as sitesTable } from '../db/schema.ts'

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
}

const blockSelection = {
  id: blocksTable.id,
  block: blocksTable.block,
  name: blocksTable.name,
  description: blocksTable.description,
  icon: blocksTable.icon,
  isEnabled: blocksTable.isEnabled,
  isCustom: blocksTable.isCustom,
  config: blocksTable.config
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
      WIKI.logger.info(`Found ${this.definitions.length} blocks [ OK ]`)
      await this.warnIfStale(manifestPath)
    } catch (err: any) {
      this.definitions = []
      this.manifestLoaded = false
      WIKI.logger.warn(
        `Could not read the blocks manifest at ${manifestPath} — run "npm run build" in blocks/. [ SKIPPED ]`
      )
      WIKI.logger.warn(err.message)
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
          `${stale.join(', ')} changed since the blocks manifest was built — run "npm run build" in blocks/ and restart to pick that up.`
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
        await WIKI.db.insert(blocksTable).values({
          siteId,
          block: definition.block,
          name: definition.name,
          description: definition.description,
          icon: definition.icon,
          isEnabled: true,
          isCustom: false,
          config: {}
        })
        added++
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
      WIKI.logger.warn('Skipping block registration: the manifest could not be read. [ SKIPPED ]')
      return
    }
    WIKI.logger.info('Registering blocks for all sites...')
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    const total = { added: 0, updated: 0, removed: 0 }
    for (const site of sites) {
      const counts = await WIKI.models.blocks.syncSite(site.id)
      total.added += counts.added
      total.updated += counts.updated
      total.removed += counts.removed
    }
    WIKI.logger.info(`Registered blocks for ${sites.length} sites [ OK ]`)
    if (total.added || total.updated || total.removed) {
      WIKI.logger.info(
        `Blocks changed on disk: ${total.added} added, ${total.updated} updated, ${total.removed} removed.`
      )
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
      `props` and `configFields` come from the manifest rather than the row: they describe the
      component's own attributes, so they belong to the installed code and not to a site's copy of it.
      Reading them here means an updated block's fields are correct the moment it is deployed, with
      nothing to migrate — and a custom block, having no manifest entry, simply reports none. `config`
      itself (the admin-set values) still comes from the row — it is the site's own data, not the
      code's.
    */
    return (results as SiteBlock[]).map((row) => {
      const definition = this.definitions.find((d) => d.block === row.block)
      return {
        ...row,
        props: definition?.props ?? [],
        configFields: definition?.config ?? [],
        template: definition?.template ?? ''
      }
    })
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
   * Deliberately loose beyond that: values are written as given, with no per-field type check against
   * `BlockProp.type`. This mirrors how page-authored `props` are already trusted — `blockAllowances()`
   * in `models/rendering.ts` allow-lists an embedded block's attributes by name only, taking whatever
   * string value came with them — so `config` is held to the same standard as the sibling data an
   * admin's site-level form and an author's page-level markup both ultimately feed into the same
   * component. This is a deliberate choice for new code, not a preserved pre-existing gap: revisit it
   * if a block ever needs a config value trusted for more than passing through to its own component
   * (e.g. interpolated into a URL fetched server-side).
   */
  private sanitizeConfig(
    blockKey: string | undefined,
    config: Record<string, any>
  ): Record<string, any> {
    const definition = this.definitions.find((d) => d.block === blockKey)
    const declared = new Set((definition?.config ?? []).map((field) => field.name))
    return Object.fromEntries(Object.entries(config).filter(([key]) => declared.has(key)))
  }

  /**
   * Enable or disable blocks in bulk, optionally updating each one's site-level `config`.
   *
   * A state with no `config` writes only `isEnabled`, leaving the row's existing config untouched —
   * batched with `inArray` like before. A state that does carry `config` needs its own `UPDATE`, since
   * a differing JSONB value per row cannot be expressed as one batched write; that config is sanitized
   * first via `sanitizeConfig`, keyed by the row's own `block` (fetched up front, since the request
   * only carries the row id).
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
            .select({ id: blocksTable.id, block: blocksTable.block })
            .from(blocksTable)
            .where(and(eq(blocksTable.siteId, siteId), inArray(blocksTable.id, ids)))
        : []
    const blockKeyById = new Map(rows.map((row) => [row.id, row.block]))

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
        const config = this.sanitizeConfig(blockKeyById.get(state.id), state.config)
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
   * Delete a custom block. Built-in blocks are rejected, since the next sync would recreate them.
   *
   * @returns Whether a block was deleted
   */
  async deleteCustomBlock(siteId: string, id: string): Promise<boolean> {
    const result = await WIKI.db
      .delete(blocksTable)
      .where(
        and(eq(blocksTable.siteId, siteId), eq(blocksTable.id, id), eq(blocksTable.isCustom, true))
      )
    return (result.rowCount ?? 0) > 0
  }
}

export const blocks = new Blocks()
