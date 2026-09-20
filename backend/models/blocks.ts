import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { CustomError, isUniqueViolation } from '../helpers/common.ts'
import {
  blockCode as blockCodeTable,
  blocks as blocksTable,
  sites as sitesTable
} from '../db/schema.ts'

export interface BlockProp {
  name: string
  type: 'string' | 'number' | 'boolean' | 'select'
  label?: string
  hint?: string
  required?: boolean
  options?: string[]
  default?: string | number | boolean
}

export interface BlockDefinition {
  block: string
  name: string
  description: string
  icon: string
  props?: BlockProp[]
  /**
   * Site-level fields an admin sets once for the whole site, as opposed to `props`, which an author
   * sets per use in the editor. Same shape, reused rather than duplicated: a tile server URL or an
   * API key is the same kind of field, just filled in by a different person.
   */
  config?: BlockProp[]
  /**
   * A block that only ever appears inside another one, such as a single tab of a set of tabs. Never
   * registered for a site: not something to insert on its own, nor to switch off separately from its
   * parent. Declared anyway, because that is what lets its tag and attributes survive a page save.
   */
  isChild?: boolean
  /** Body the editor writes between the block's opening and closing lines on insert. */
  template?: string
}

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
  /** The custom element name, always `block-{block}` -- derived, never stored. */
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
  // -> Aliased so `getSiteBlocks()` below can pick a source (this row, or the manifest) per block
  //    without a built-in's empty defaults colliding with the field names it maps them onto.
  customProps: blocksTable.props,
  customTemplate: blocksTable.template
}

/**
 * Built-in blocks live in the `blocks/` workspace, one directory per block. Their metadata is
 * declared as a `static definition` on each Lit component and collected into
 * `blocks/compiled/blocks.manifest.json` by the rollup build, which is what this model reads —
 * the components themselves cannot be imported outside a browser.
 */
class Blocks {
  definitions: BlockDefinition[] = []

  /**
   * Told apart from "the manifest lists nothing": an empty manifest says every built-in block has
   * been removed, a missing one says nothing at all.
   */
  private manifestLoaded = false

  /**
   * A missing manifest is not fatal: `blocks/compiled` is a build output and is not in the
   * repository, so a fresh checkout has none until `npm run build` has been run in `blocks/`.
   */
  async refreshFromDisk(): Promise<void> {
    const manifestPath = path.join(CARDINAL.ROOTPATH, 'blocks/compiled/blocks.manifest.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (!Array.isArray(manifest)) {
        throw new TypeError('Manifest is not an array.')
      }
      this.definitions = manifest
      this.manifestLoaded = true
      CARDINAL.logger.debug('blocks', 'loaded the manifest', { blocks: this.definitions.length })
      await this.warnIfStale(manifestPath)
    } catch (err: any) {
      this.definitions = []
      this.manifestLoaded = false
      CARDINAL.logger.warn(
        'blocks',
        'could not read the manifest, run "npm run build" in blocks/',
        {
          path: manifestPath,
          error: err
        }
      )
    }
  }

  /**
   * Nothing rebuilds the manifest on the way in here, so editing a block and restarting the server
   * looks like the change was ignored, when what happened is that the server read a manifest
   * describing the previous version.
   *
   * Only in a source tree: a packaged instance ships `blocks/compiled` without the sources beside it,
   * where there is nothing to compare against and nothing anybody could rebuild.
   */
  private async warnIfStale(manifestPath: string): Promise<void> {
    try {
      const sourcePath = path.join(CARDINAL.ROOTPATH, 'blocks')
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
        CARDINAL.logger.warn(
          'blocks',
          'changed since the manifest was built — run "npm run build" in blocks/ and restart to pick that up',
          { blocks: stale.join(', ') }
        )
      }
    } catch {
      // -> No sources to compare against: the normal state of a packaged instance
    }
  }

  /**
   * `isEnabled` and `config` are the site's own and are never touched — which is why an existing row
   * is updated rather than replaced. Custom blocks are left alone entirely: they have no on-disk
   * counterpart.
   */
  async syncSite(siteId: string): Promise<{ added: number; updated: number; removed: number }> {
    const existing = await CARDINAL.db
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
        //    `existing` with nothing there and both reach this insert. The second would otherwise
        //    23505 on `blocks_composite_idx` and abort `postBoot()`.
        const [inserted] = await CARDINAL.db
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
      // -> Written only when it would change something, so the count below means what it says
      if (
        row.name !== definition.name ||
        row.description !== definition.description ||
        row.icon !== definition.icon
      ) {
        await CARDINAL.db
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
      await CARDINAL.db
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
   * Skipped outright when the manifest could not be read, rather than run against an empty list of
   * definitions: that would read as "every built-in block has been uninstalled" and delete each
   * site's rows, taking which blocks it had switched on with them.
   */
  async syncAllSites(): Promise<void> {
    if (!this.manifestLoaded) {
      CARDINAL.logger.warn('blocks', 'skipping registration, the manifest could not be read')
      return
    }
    const sites = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
    const total = { added: 0, updated: 0, removed: 0 }
    for (const site of sites) {
      const counts = await CARDINAL.models.blocks.syncSite(site.id)
      total.added += counts.added
      total.updated += counts.updated
      total.removed += counts.removed
    }
    CARDINAL.logger.info('blocks', 'registered blocks', { sites: sites.length })
    if (total.added || total.updated || total.removed) {
      CARDINAL.logger.info('blocks', 'blocks changed on disk', {
        added: total.added,
        updated: total.updated,
        removed: total.removed
      })
    }
  }

  async getSiteBlocks(siteId: string): Promise<SiteBlock[]> {
    const results = await CARDINAL.db
      .select(blockSelection)
      .from(blocksTable)
      .where(eq(blocksTable.siteId, siteId))
      .orderBy(blocksTable.isCustom, blocksTable.name)
    /*
      A built-in block's `props`/`configFields`/`template` come from the manifest rather than the row:
      they belong to the installed code, not to a site's copy of it, so an updated block's fields are
      correct the moment it is deployed, with nothing to migrate.

      A custom block has no manifest entry — it is what was uploaded, not installed code — so it
      sources `props`/`template` from its own row and reports no `configFields` at all, which is why
      its `config` is written as given (see `sanitizeConfig()` below).
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
   * Every custom row, not only enabled ones — `blockAllowances()` (`helpers/htmlSanitizePolicy.ts`)
   * already has `getEnabledKeys()`'s answer and applies that filter itself; a second copy of the rule
   * here could disagree with it.
   *
   * Prop names are trusted here without a second check:
   * `helpers/blockDefinition.ts#extractBlockDefinition()` is what stands between an uploaded prop
   * name and the sanitizer's attribute allowlist, at upload time — this is a plain read, not a gate.
   */
  async getCustomBlockDefinitions(
    siteId: string
  ): Promise<{ block: string; props: BlockProp[] }[]> {
    const rows = await CARDINAL.db
      .select({ block: blocksTable.block, props: blocksTable.props })
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.isCustom, true)))
    return rows.map((row) => ({ block: row.block, props: (row.props as BlockProp[]) ?? [] }))
  }

  /**
   * Read from the database on every call rather than kept in a cache like this model's definitions.
   * What this answer gates is which blocks survive a page being saved, and a stale `false` silently
   * strips an author's block out of their page — a wrong answer here destroys content rather than
   * merely showing the wrong list.
   *
   * Child blocks never appear: they have no row of their own, and follow the block they sit in.
   */
  async getEnabledKeys(siteId: string): Promise<Set<string>> {
    const rows = await CARDINAL.db
      .select({ block: blocksTable.block })
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.isEnabled, true)))
    return new Set(rows.map((row) => row.block))
  }

  /**
   * `block` is resolved from the row rather than trusted from the request body, since the point of
   * this pass is that the caller cannot assert its way past it. A block's `config` field list can
   * change shape between deploys, and nothing else removes a key left over from a previous shape: the
   * admin form is generated from the current `configFields` and cannot show or clear one it no longer
   * knows about.
   *
   * A custom block is passed through untouched — it has no manifest declaration to check `config`
   * against. Deliberately loose beyond that: values are written as given, with no per-field type
   * check against `BlockProp.type`, mirroring how page-authored `props` are already trusted.
   * `assertValidConfig()` below is the one carve-out.
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
   * The one carve-out from the "no per-field validation" note above: block-plantuml's and
   * block-kroki's `server` is fetched server-side (`models/diagramRender.ts`,
   * `models/diagramProxy.ts`), unlike every other block's config, which is only ever handed to that
   * block's own client-side component. Left unchecked it is exactly the SSRF this config field exists
   * to close off, so it is refused when an admin writes it rather than when a reader's request later
   * makes this model fetch whatever was stored.
   *
   * Empty falls back to the public default; anything else must parse as a URL, be `http:`/`https:`,
   * and carry neither a query string nor a fragment — a query string is what lets a server value fold
   * `/${format}/${encoded}` into itself and reach an arbitrary path on an otherwise-fine host.
   */
  private assertValidConfig(blockKey: string, config: Record<string, any>): void {
    if (blockKey !== 'plantuml' && blockKey !== 'kroki') {
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
        `The ${blockKey === 'kroki' ? 'Kroki' : 'PlantUML'} server must be an http:// or https:// URL, not "${parsed.protocol}".`,
        400
      )
    }
    if (parsed.search || parsed.hash) {
      throw new CustomError(
        'blocksInvalidConfig',
        `The ${blockKey === 'kroki' ? 'Kroki' : 'PlantUML'} server URL may not contain a query string or fragment.`,
        400
      )
    }
  }

  /**
   * A state with no `config` writes only `isEnabled` and is batched with `inArray`; one that carries
   * `config` needs its own `UPDATE`, since a differing JSONB value per row cannot be expressed as one
   * batched write. That config is sanitized first, keyed by the row's own `block`/`isCustom` — which
   * is why the rows are fetched up front, the request carrying only the row id.
   *
   * Omitting `config` leaves the row's untouched — an empty object `{}` is a deliberate "clear
   * whatever was set", not the same as "say nothing about it".
   *
   * Deliberately queues no re-render of pages already embedding a block disabled here:
   * `helpers/htmlSanitizePolicy.ts#blockAllowances` is what keeps one from reaching a reader anyway.
   *
   * @returns Rows written — a block already in the requested state still counts
   */
  async setBlocksState(
    siteId: string,
    states: { id: string; isEnabled: boolean; config?: Record<string, any> }[]
  ): Promise<number> {
    let changed = 0

    const ids = states.map((s) => s.id)
    const rows =
      ids.length > 0
        ? await CARDINAL.db
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
        const result = await CARDINAL.db
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
        const result = await CARDINAL.db
          .update(blocksTable)
          .set({ isEnabled, config })
          .where(and(eq(blocksTable.siteId, siteId), eq(blocksTable.id, state.id)))
        changed += result.rowCount ?? 0
      }
    }
    return changed
  }

  /**
   * Scoped to `siteId` and `isCustom` the same way `deleteCustomBlock()` is: a block id alone is not
   * enough to say a caller may have it, and a built-in has no row in `blockCode` to find anyway.
   */
  async getCustomBlockCode(siteId: string, id: string): Promise<Buffer | undefined> {
    const [row] = await CARDINAL.db
      .select({ code: blockCodeTable.code })
      .from(blockCodeTable)
      .innerJoin(blocksTable, eq(blockCodeTable.blockId, blocksTable.id))
      .where(
        and(eq(blocksTable.siteId, siteId), eq(blocksTable.id, id), eq(blocksTable.isCustom, true))
      )
    return row?.code
  }

  /**
   * A block's tag becomes `<block-{tag}>` in a rendered page, so two blocks answering to the same one
   * would silently shadow one with the other rather than fail loudly.
   *
   * The built-in half is answered from the in-memory manifest rather than a query: a site's built-in
   * rows are always exactly what `syncSite()` last wrote from it, so it is the manifest that is
   * authoritative, not the copy in `blocks`. Only the custom half needs the database, since that is
   * the one kind of row with no on-disk source of truth.
   */
  async isTagTaken(siteId: string, tag: string): Promise<boolean> {
    if (this.definitions.some((d) => d.block === tag)) {
      return true
    }
    const [row] = await CARDINAL.db
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
   * The row and its compiled code are written in one transaction, so a failure partway through never
   * leaves one without the other. `isEnabled` defaults to `true`, the same as a built-in gets on
   * first sync — a block an administrator just uploaded is one they meant to make available.
   *
   * Callers are expected to have already resolved the tag collision with `isTagTaken()`, which this
   * still races against: two uploads for the same tag can both pass that check and both reach this
   * insert, so `blocks_composite_idx` is what actually decides the winner. The loser's `23505` is
   * surfaced as a 409 `CustomError` rather than an unhandled raw error.
   */
  async createCustomBlock(
    siteId: string,
    definition: BlockDefinition,
    code: Buffer
  ): Promise<SiteBlock> {
    return CARDINAL.db.transaction(async (tx) => {
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
   * Built-in blocks are rejected, since the next sync would recreate them.
   *
   * The stored code goes with the row — `blockCode` is a separate table, so deleting `blocks` alone
   * would orphan it. Done inside a transaction, code first, so this method is what is actually
   * responsible for the code going away rather than the foreign key's `onDelete: 'cascade'` (kept as
   * a safety net for a row reached some other way).
   */
  async deleteCustomBlock(siteId: string, id: string): Promise<boolean> {
    return CARDINAL.db.transaction(async (tx) => {
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
