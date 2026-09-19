import fs from 'node:fs/promises'
import path from 'node:path'
import { and, count, eq, ilike, inArray } from 'drizzle-orm'
import { getIconData, iconToHTML, iconToSVG, replaceIDs } from '@iconify/utils'
import { LRUCache } from 'lru-cache'
import { isPlainObject } from 'es-toolkit/predicate'
import { icons as iconsTable, iconSets as iconSetsTable } from '../db/schema.ts'
import { escapeLikePattern } from '../helpers/common.ts'
import type { IconifyIconCustomisations } from '@iconify/utils'
import type { IconifyIcon, IconifyInfo, IconifyJSON } from '@iconify/types'

/**
 * An icon set as stored, without the per-set icon count -- what a single-row lookup by prefix can
 * answer without touching the (potentially large) `icons` table.
 */
export interface IconSetRow {
  prefix: string
  name: string
  isEnabled: boolean
  info: IconifyInfo | Record<string, never>
  refreshedAt: Date | null
  createdAt: Date
}

export interface IconSet extends IconSetRow {
  /** How many of the set's icons are stored here, i.e. servable without the upstream API. */
  iconCount: number
}

export interface AvailableIconSet {
  prefix: string
  name: string
  total: number
  author: string
  license: string
  category: string
  /** Whether the set's icons carry their own colors, i.e. cannot be recolored with `currentColor`. */
  palette: boolean
  samples: string[]
  isAdded: boolean
}

/** In the shape the Iconify API protocol expects. */
export interface ResolvedIcons {
  icons: Record<string, IconifyIcon>
  notFound: string[]
}

/**
 * Icon sets seeded on a fresh instance, so that the picker is usable before an administrator has
 * added anything. The names are the upstream ones and get overwritten by the first metadata refresh.
 *
 * Tabler leads the list because it is the set the interface itself is drawn in, so an icon a user
 * picks for a page or a navigation item sits in the same hand as the chrome around it unless they
 * deliberately reach past it.
 *
 * Font Awesome Free is its three Iconify collections, not the single `fa` prefix:
 * `fa6-solid`/`fa6-regular`/`fa6-brands` are the current (v6) free-tier sets upstream splits style
 * into, distinct from `fa` (the old v4 icon-font mapping) and from a paid Pro tier never seeded here.
 */
export const DEFAULT_SETS: { prefix: string; name: string }[] = [
  { prefix: 'tabler', name: 'Tabler Icons' },
  { prefix: 'mdi', name: 'Material Design Icons' },
  { prefix: 'la', name: 'Line Awesome' },
  { prefix: 'fa6-solid', name: 'Font Awesome 6 Solid' },
  { prefix: 'fa6-regular', name: 'Font Awesome 6 Regular' },
  { prefix: 'fa6-brands', name: 'Font Awesome 6 Brands' }
]

const PREFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NAME_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/

/** An icon body is ~1 kB, so this bound costs a few MB per instance. */
const MEMORY_CACHE_MAX = 2000

const CATALOG_TTL_MS = 60 * 60 * 1000

/**
 * Ceiling on upstream requests per minute, across every caller. The public icon route fills the
 * cache on a miss and is reachable by anyone who can read a page, so without a ceiling a stream of
 * requests for icons that do not exist is amplified into a stream of requests to the Iconify API.
 */
const UPSTREAM_BUDGET_PER_MINUTE = 60

const NOT_FOUND_TTL_MS = 60 * 60 * 1000

/**
 * Bounds `notFoundCache`: a public, unmetered route driving a stream of never-repeated misses would
 * otherwise grow it forever between restarts.
 */
export const NOT_FOUND_CACHE_MAX = 5000

/**
 * Reject anything that could execute when an icon is opened directly rather than drawn into a page.
 * Icon bodies come from a third-party API, and nothing legitimate in one needs a script, an event
 * handler or an external reference.
 */
function isSafeIconBody(body: string): boolean {
  return !/<script|<foreignobject|<iframe|<use[^>]+href\s*=\s*["']?https?:|\son\w+\s*=|javascript:/i.test(
    body
  )
}

/**
 * The documented "upstream has nothing for this" shape -- a genuine HTTP 404, or a 200-status
 * response whose JSON body is the literal string `'404'`. A routine outcome, not a failure:
 * `fetchIconsUpstream` catches it separately so it logs at `debug` rather than `warn`.
 */
export class IconNotFoundUpstreamError extends Error {}

/**
 * Validates one parsed sideload file as a full Iconify collection export -- the shape
 * `api.iconify.design`'s own `/<prefix>.json` responses use. Only `icons` is required, exactly as in
 * a real upstream export, and the set's prefix comes from the filename rather than a `prefix` field
 * here, so the file stays the untouched vendored/exported JSON.
 */
export function parseSideloadIconCollection(
  raw: unknown
): { ok: true; collection: IconifyJSON } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'not a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  if (!isPlainObject(obj.icons)) {
    return { ok: false, error: 'missing required object field "icons"' }
  }
  if (obj.aliases !== undefined && !isPlainObject(obj.aliases)) {
    return { ok: false, error: '"aliases" must be an object when present' }
  }
  if (obj.info !== undefined && !isPlainObject(obj.info)) {
    return { ok: false, error: '"info" must be an object when present' }
  }
  return { ok: true, collection: obj as unknown as IconifyJSON }
}

/**
 * Icons are addressed the way Iconify addresses them — `<prefix>:<name>`, e.g. `tabler:user-edit` —
 * and that reference is all content ever stores. Resolving one to markup goes through four tiers:
 *
 * 1. **memory**, per instance, for the icons a page is actually made of
 * 2. **disk**, under `<dataPath>/cache/icons`, one small JSON file per icon
 * 3. **the database**, the permanent record: every icon the wiki has ever served lives here, so a new
 *    instance with an empty disk (or an instance with no outbound network at all) serves everything
 *    that content references
 * 4. **the Iconify API**, consulted only for an icon nobody has used yet, and then persisted
 *
 * Rendering a page never resolves an icon: the page carries names and the browser asks for the icons
 * it needs in one batch.
 */
class Icons {
  /** Resolved icon data, keyed `prefix:name`. Insertion-ordered, so the oldest entry is evictable. */
  memoryCache = new Map<string, IconifyIcon>()

  /**
   * Names upstream has no icon for, keyed `prefix:name`. An `LRUCache` rather than a plain `Map`:
   * `max` bounds it and `ttl` expires entries, so `has()` answers `false` for a stale one on its own.
   */
  notFoundCache = new LRUCache<string, true>({ max: NOT_FOUND_CACHE_MAX, ttl: NOT_FOUND_TTL_MS })

  catalogCache = new Map<string, { fetchedAt: number; data: any }>()

  upstreamBudget = { windowStartedAt: 0, used: 0 }

  get cachePath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'cache/icons')
  }

  get apiUrl(): string {
    return CARDINAL.config.icons?.apiUrl || 'https://api.iconify.design'
  }

  parseRef(ref: string): { prefix: string; name: string } | null {
    const [prefix, name, ...rest] = `${ref}`.toLowerCase().split(':')
    if (!prefix || !name || rest.length > 0) {
      return null
    }
    return this.isValidRef(prefix, name) ? { prefix, name } : null
  }

  /** Both end up in a file path, so this is what keeps `../` and friends out of the disk cache. */
  isValidRef(prefix: string, name: string): boolean {
    return PREFIX_PATTERN.test(prefix) && NAME_PATTERN.test(name)
  }

  async getSets(): Promise<IconSet[]> {
    const sets = await CARDINAL.db.select().from(iconSetsTable).orderBy(iconSetsTable.name)
    const counts = await CARDINAL.db
      .select({ prefix: iconsTable.prefix, total: count() })
      .from(iconsTable)
      .groupBy(iconsTable.prefix)
    return sets.map((set) => ({
      ...set,
      info: (set.info ?? {}) as IconifyInfo,
      iconCount: counts.find((c) => c.prefix === set.prefix)?.total ?? 0
    })) as IconSet[]
  }

  /**
   * Deliberately a single-row, no-aggregate query: the public `/_icons` batch route calls this on
   * every request, before `resolveIcons` gets a chance to answer from memory, and `getSets()`'s
   * `count() … group by` over the whole `icons` table has no place on that path.
   */
  async getSet(prefix: string): Promise<IconSetRow | null> {
    const rows = await CARDINAL.db
      .select()
      .from(iconSetsTable)
      .where(eq(iconSetsTable.prefix, prefix))
      .limit(1)
    const set = rows[0]
    return set ? { ...set, info: (set.info ?? {}) as IconifyInfo } : null
  }

  async getEnabledPrefixes(): Promise<string[]> {
    const sets = await CARDINAL.db
      .select({ prefix: iconSetsTable.prefix })
      .from(iconSetsTable)
      .where(eq(iconSetsTable.isEnabled, true))
    return sets.map((s) => s.prefix)
  }

  /** Takes the set's name and metadata from upstream. */
  async addSet(prefix: string): Promise<IconSet> {
    if (!PREFIX_PATTERN.test(prefix)) {
      return Promise.reject(new Error(`"${prefix}" is not a valid icon set prefix.`))
    }
    if (await this.getSet(prefix)) {
      return Promise.reject(new Error(`The ${prefix} icon set has already been added.`))
    }
    const collections = await this.getCollections()
    const info = collections[prefix]
    if (!info) {
      return Promise.reject(new Error(`There is no "${prefix}" icon set available upstream.`))
    }

    const inserted = await CARDINAL.db
      .insert(iconSetsTable)
      .values({
        prefix,
        name: info.name ?? prefix,
        isEnabled: true,
        info,
        refreshedAt: new Date()
      })
      .returning()
    CARDINAL.logger.info('icons', 'added icon set', { prefix })
    const set = inserted[0]!
    // -> A just-added set has no icons stored for it yet, so `iconCount` needs no query
    return { ...set, info: (set.info ?? {}) as IconifyInfo, iconCount: 0 }
  }

  /**
   * A disabled set stops being searchable and stops being filled from upstream, but the icons already
   * stored for it keep being served: content referencing them is already published, and answering
   * those requests with nothing would silently break pages.
   */
  async setSetState(prefix: string, isEnabled: boolean): Promise<boolean> {
    const result = await CARDINAL.db
      .update(iconSetsTable)
      .set({ isEnabled })
      .where(eq(iconSetsTable.prefix, prefix))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Deletes every icon stored for the set too. Content referencing those icons stops rendering them,
   * which is why the admin area asks first.
   */
  async deleteSet(prefix: string): Promise<number> {
    const deletedIcons = await CARDINAL.db.delete(iconsTable).where(eq(iconsTable.prefix, prefix))
    await CARDINAL.db.delete(iconSetsTable).where(eq(iconSetsTable.prefix, prefix))

    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${prefix}:`)) {
        this.memoryCache.delete(key)
      }
    }
    await fs.rm(path.join(this.cachePath, prefix), { recursive: true, force: true })

    CARDINAL.logger.info('icons', 'deleted icon set', { prefix })
    return deletedIcons.rowCount ?? 0
  }

  /** Re-reads metadata only — a set's stored icons are untouched. */
  async refreshSets(): Promise<number> {
    const collections = await this.getCollections()
    const sets = await CARDINAL.db.select({ prefix: iconSetsTable.prefix }).from(iconSetsTable)
    let refreshed = 0
    for (const set of sets) {
      const info = collections[set.prefix]
      if (!info) {
        // -> A set can be renamed or withdrawn upstream; keeping the row is deliberate, since its
        //    icons are stored here and content still references them
        CARDINAL.logger.warn('icons', 'icon set is no longer offered upstream', {
          prefix: set.prefix
        })
        continue
      }
      await CARDINAL.db
        .update(iconSetsTable)
        .set({ name: info.name ?? set.prefix, info, refreshedAt: new Date() })
        .where(eq(iconSetsTable.prefix, set.prefix))
      refreshed++
    }
    return refreshed
  }

  async getCollections(): Promise<Record<string, IconifyInfo>> {
    return this.fetchCatalog('collections', '/collections')
  }

  async getAvailableSets(): Promise<AvailableIconSet[]> {
    const [collections, added] = await Promise.all([
      this.getCollections(),
      CARDINAL.db.select({ prefix: iconSetsTable.prefix }).from(iconSetsTable)
    ])
    const addedPrefixes = added.map((s) => s.prefix)
    return Object.entries(collections)
      .map(([prefix, info]) => ({
        prefix,
        name: info.name ?? prefix,
        total: info.total ?? 0,
        author: info.author?.name ?? '',
        license: info.license?.title ?? '',
        category: info.category ?? '',
        palette: info.palette === true,
        samples: info.samples ?? [],
        isAdded: addedPrefixes.includes(prefix)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The names of every icon in a set, for browsing it without a search term. */
  async listSetIcons(prefix: string): Promise<string[]> {
    const set = await this.getSet(prefix)
    if (!set?.isEnabled) {
      return Promise.reject(new Error(`The ${prefix} icon set is not available.`))
    }
    const collection = await this.fetchCatalog(
      `collection:${prefix}`,
      `/collection?prefix=${encodeURIComponent(prefix)}`
    )
    // -> Upstream groups icons into `categories`, a flat `uncategorized` list, or both. `hidden` is
    //    deprecated icons kept for compatibility, so it is deliberately not read.
    const categorized = Object.values(
      (collection.categories ?? {}) as Record<string, string[]>
    ).flat()
    const names = [...categorized, ...((collection.uncategorized ?? []) as string[])]
    return [...new Set(names)].sort()
  }

  /**
   * Search icons upstream, within the sets that are enabled here.
   *
   * Degrades to `searchIconsLocally` rather than surfacing a hard failure, both in offline mode
   * (checked up front, so a doomed network attempt is never made) and on a genuine upstream failure.
   * So it never rejects for "upstream could not be reached" -- only an unexpected failure in the
   * fallback path itself, e.g. the database being unreachable.
   *
   * @returns References shaped `prefix:name`
   */
  async searchIcons({
    query,
    prefixes,
    limit = 96
  }: {
    query: string
    prefixes?: string[]
    limit?: number
  }): Promise<string[]> {
    const enabled = await this.getEnabledPrefixes()
    // -> Searching a disabled set would offer icons that cannot then be stored
    const searchIn = prefixes?.length ? prefixes.filter((p) => enabled.includes(p)) : enabled
    if (searchIn.length < 1) {
      return []
    }
    const clampedLimit = Math.min(Math.max(limit, 32), 999)

    if (CARDINAL.config.offline) {
      return this.searchIconsLocally(query, searchIn, clampedLimit)
    }

    const params = new URLSearchParams({
      query,
      limit: `${clampedLimit}`,
      prefixes: searchIn.join(',')
    })
    try {
      const result = await this.apiFetch(`/search?${params}`)
      return (result.icons ?? []) as string[]
    } catch (err: any) {
      CARDINAL.logger.warn(
        'icons',
        'could not search the Iconify API, falling back to local icons',
        {
          error: err
        }
      )
      return this.searchIconsLocally(query, searchIn, clampedLimit)
    }
  }

  /**
   * `searchIcons()`'s offline/unreachable fallback: the permanent tier only, so results are limited
   * to icons already materialized here rather than the full breadth of an enabled set's catalog.
   *
   * @returns References shaped `prefix:name`
   */
  async searchIconsLocally(query: string, prefixes: string[], limit: number): Promise<string[]> {
    const pattern = `%${escapeLikePattern(query)}%`
    const rows = await CARDINAL.db
      .select({ prefix: iconsTable.prefix, name: iconsTable.name })
      .from(iconsTable)
      .where(and(inArray(iconsTable.prefix, prefixes), ilike(iconsTable.name, pattern)))
      .limit(limit)
    return rows.map((row) => `${row.prefix}:${row.name}`)
  }

  /** Memoized: catalogs are large and change rarely, but the admin area and picker ask often. */
  async fetchCatalog(key: string, pathname: string): Promise<any> {
    const cached = this.catalogCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached.data
    }
    const data = await this.apiFetch(pathname)
    this.catalogCache.set(key, { fetchedAt: Date.now(), data })
    return data
  }

  /**
   * Resolve icons of one set, filling the cache from upstream for any the wiki does not hold yet.
   *
   * @param allowUpstream False for callers that must not cause outbound traffic, e.g. a bulk render.
   */
  async resolveIcons(
    prefix: string,
    names: string[],
    { allowUpstream = true }: { allowUpstream?: boolean } = {}
  ): Promise<ResolvedIcons> {
    const wanted = [...new Set(names)].filter((name) => this.isValidRef(prefix, name))
    const icons: Record<string, IconifyIcon> = {}
    const missing: string[] = []

    for (const name of wanted) {
      const cached = this.memoryCache.get(`${prefix}:${name}`)
      if (cached) {
        icons[name] = cached
      } else {
        missing.push(name)
      }
    }
    if (missing.length < 1) {
      return { icons, notFound: [] }
    }

    const stillMissingAfterDisk: string[] = []
    for (const name of missing) {
      const cached = await this.readDiskCache(prefix, name)
      if (cached) {
        this.remember(prefix, name, cached)
        icons[name] = cached
      } else {
        stillMissingAfterDisk.push(name)
      }
    }
    if (stillMissingAfterDisk.length < 1) {
      return { icons, notFound: [] }
    }

    const rows = await CARDINAL.db
      .select()
      .from(iconsTable)
      .where(and(eq(iconsTable.prefix, prefix), inArray(iconsTable.name, stillMissingAfterDisk)))
    for (const row of rows) {
      const icon = this.rowToIcon(row)
      this.remember(prefix, row.name, icon)
      await this.writeDiskCache(prefix, row.name, icon)
      icons[row.name] = icon
    }

    const stillMissing = stillMissingAfterDisk.filter((name) => !(name in icons))
    if (stillMissing.length < 1) {
      return { icons, notFound: [] }
    }
    if (!allowUpstream) {
      return { icons, notFound: stillMissing }
    }

    const fetched = await this.fetchIconsUpstream(prefix, stillMissing)
    return {
      icons: { ...icons, ...fetched.icons },
      notFound: fetched.notFound
    }
  }

  /**
   * Fetch icons from upstream and store them permanently. Refuses for a set that is not enabled, so
   * a disabled set cannot grow, and holds to the upstream budget so misses cannot be amplified.
   */
  async fetchIconsUpstream(prefix: string, names: string[]): Promise<ResolvedIcons> {
    const set = await this.getSet(prefix)
    if (!set?.isEnabled) {
      return { icons: {}, notFound: names }
    }

    const asking = names.filter((name) => !this.isKnownMissing(prefix, name))
    if (asking.length < 1) {
      return { icons: {}, notFound: names }
    }
    if (!this.claimUpstreamBudget()) {
      CARDINAL.logger.warn('icons', 'upstream request budget exhausted, not fetching', {
        prefix,
        icons: asking.join(',')
      })
      return { icons: {}, notFound: names }
    }

    let iconSet: IconifyJSON
    try {
      iconSet = (await this.apiFetch(
        `/${prefix}.json?icons=${asking.map(encodeURIComponent).join(',')}`
      )) as IconifyJSON
    } catch (err: any) {
      if (err instanceof IconNotFoundUpstreamError) {
        CARDINAL.logger.debug('icons', 'upstream has no icons for this request', {
          prefix,
          icons: asking.join(',')
        })
      } else {
        CARDINAL.logger.warn('icons', 'fetching icons upstream failed', {
          url: this.apiUrl,
          prefix,
          error: err
        })
      }
      return { icons: {}, notFound: names }
    }

    const icons: Record<string, IconifyIcon> = {}
    const notFound: string[] = []
    for (const name of asking) {
      // -> Resolves aliases, character references and set-level defaults into one self-contained icon
      const data = getIconData(iconSet, name)
      if (!data?.body) {
        notFound.push(name)
        this.rememberMissing(prefix, name)
        continue
      }
      if (!isSafeIconBody(data.body)) {
        notFound.push(name)
        CARDINAL.logger.warn('icons', 'refused an unsafe icon body', { prefix, icon: name })
        continue
      }
      icons[name] = data
      await this.storeIcon(prefix, name, data)
      await this.writeDiskCache(prefix, name, data)
      this.remember(prefix, name, data)
    }

    if (Object.keys(icons).length > 0) {
      CARDINAL.logger.debug('icons', 'stored new icons', {
        prefix,
        icons: Object.keys(icons).length
      })
    }
    return { icons, notFound: [...notFound, ...names.filter((n) => !asking.includes(n))] }
  }

  async storeIcon(prefix: string, name: string, icon: IconifyIcon): Promise<void> {
    const values = {
      prefix,
      name,
      body: icon.body,
      width: icon.width ?? 16,
      height: icon.height ?? 16,
      left: icon.left ?? 0,
      top: icon.top ?? 0,
      rotate: icon.rotate ?? 0,
      hFlip: icon.hFlip ?? false,
      vFlip: icon.vFlip ?? false
    }
    await CARDINAL.db
      .insert(iconsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [iconsTable.prefix, iconsTable.name],
        set: values
      })
  }

  /**
   * Materialize icons so the wiki can serve them without the upstream API. Called when an icon is
   * picked, i.e. while the author is online and before anyone else needs it.
   *
   * @param refs References shaped `prefix:name`
   * @returns The references that could not be stored
   */
  async materializeIcons(refs: string[]): Promise<string[]> {
    const byPrefix = new Map<string, string[]>()
    const invalid: string[] = []
    for (const ref of refs) {
      const parsed = this.parseRef(ref)
      if (!parsed) {
        invalid.push(ref)
        continue
      }
      byPrefix.set(parsed.prefix, [...(byPrefix.get(parsed.prefix) ?? []), parsed.name])
    }

    const failed = [...invalid]
    for (const [prefix, names] of byPrefix) {
      const result = await this.resolveIcons(prefix, names)
      failed.push(...result.notFound.map((name) => `${prefix}:${name}`))
    }
    return failed
  }

  /** For the callers that can only carry a URL — an `<img>`, a CSS background. */
  async getIconSvg(
    prefix: string,
    name: string,
    { allowUpstream = true }: { allowUpstream?: boolean } = {}
  ): Promise<string | null> {
    const resolved = await this.resolveIcons(prefix, [name], { allowUpstream })
    const icon = resolved.icons[name]
    return icon ? this.renderSvg(icon) : null
  }

  /**
   * Standalone SVG markup, sized in pixels rather than the `1em` Iconify defaults to: this file is
   * also served as a plain image, and an `<img>` has no font size to scale against.
   */
  renderSvg(icon: IconifyIcon): string {
    const rendered = iconToSVG(icon, {
      width: `${icon.width ?? 16}`,
      height: `${icon.height ?? 16}`
    })
    return iconToHTML(rendered.body, rendered.attributes)
  }

  /**
   * SVG markup to be drawn INTO a document: sized in `em` — Iconify's default when neither dimension
   * is given — so the icon follows the text it sits in, and painted in `currentColor` by the body.
   *
   * `replaceIDs` is what makes it safe to have more than one on a page: an icon that masks or
   * gradients refers to its own `<defs>` by ids that come from the set rather than this document, and
   * two icons carrying the same one would each draw with whichever won. A standalone file has no such
   * problem, which is why `renderSvg` does not do this.
   */
  renderInlineSvg(icon: IconifyIcon, customisations: IconifyIconCustomisations = {}): string {
    const rendered = iconToSVG(icon, customisations)
    return iconToHTML(replaceIDs(rendered.body), rendered.attributes)
  }

  remember(prefix: string, name: string, icon: IconifyIcon): void {
    if (this.memoryCache.size >= MEMORY_CACHE_MAX) {
      const oldest = this.memoryCache.keys().next().value
      if (oldest) {
        this.memoryCache.delete(oldest)
      }
    }
    this.memoryCache.set(`${prefix}:${name}`, icon)
  }

  rememberMissing(prefix: string, name: string): void {
    this.notFoundCache.set(`${prefix}:${name}`, true)
  }

  isKnownMissing(prefix: string, name: string): boolean {
    return this.notFoundCache.has(`${prefix}:${name}`)
  }

  /** @returns Whether the request may go ahead. */
  claimUpstreamBudget(): boolean {
    const now = Date.now()
    if (now - this.upstreamBudget.windowStartedAt > 60_000) {
      this.upstreamBudget = { windowStartedAt: now, used: 0 }
    }
    if (this.upstreamBudget.used >= UPSTREAM_BUDGET_PER_MINUTE) {
      return false
    }
    this.upstreamBudget.used++
    return true
  }

  /**
   * The disk cache holds icon data rather than rendered SVG, so one cached file answers both the
   * frontend's batch data requests and an `<img>`'s SVG request — rendering is string building.
   */
  diskCachePath(prefix: string, name: string): string {
    return path.join(this.cachePath, prefix, `${name}.json`)
  }

  async readDiskCache(prefix: string, name: string): Promise<IconifyIcon | null> {
    try {
      const icon = JSON.parse(await fs.readFile(this.diskCachePath(prefix, name), 'utf8'))
      return typeof icon?.body === 'string' ? icon : null
    } catch {
      // -> Not cached yet, the normal state of a fresh container; a corrupt file is treated the same
      //    way, and either is refilled from the database
      return null
    }
  }

  /**
   * Best effort: a full or read-only disk must not stop an icon from being served, since the cache is
   * derived data every request can be answered without.
   *
   * The file is written under a temporary name and renamed, so a concurrent reader sees either the
   * previous file or the complete new one, never a half-written one.
   */
  async writeDiskCache(prefix: string, name: string, icon: IconifyIcon): Promise<void> {
    const filePath = this.diskCachePath(prefix, name)
    const tempPath = `${filePath}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(tempPath, JSON.stringify(icon), 'utf8')
      await fs.rename(tempPath, filePath)
    } catch (err: any) {
      CARDINAL.logger.warn('icons', 'writing to the icon cache failed', {
        path: filePath,
        error: err
      })
      await fs.rm(tempPath, { force: true }).catch(() => {})
    }
  }

  /** Nothing is lost: both caches are rebuilt from the database on demand. */
  async purgeCache(): Promise<void> {
    this.memoryCache.clear()
    this.notFoundCache.clear()
    this.catalogCache.clear()
    await fs.rm(this.cachePath, { recursive: true, force: true })
    await fs.mkdir(this.cachePath, { recursive: true })
    CARDINAL.logger.info('icons', 'purged the icon cache')
  }

  async getStats(): Promise<{
    setCount: number
    enabledSetCount: number
    iconCount: number
    memoryCount: number
    diskCount: number
    diskSize: number
  }> {
    const [sets, iconCount] = await Promise.all([
      CARDINAL.db.select({ isEnabled: iconSetsTable.isEnabled }).from(iconSetsTable),
      CARDINAL.db.$count(iconsTable)
    ])
    const disk = await this.measureDiskCache()
    return {
      setCount: sets.length,
      enabledSetCount: sets.filter((s) => s.isEnabled).length,
      iconCount,
      memoryCount: this.memoryCache.size,
      diskCount: disk.files,
      diskSize: disk.bytes
    }
  }

  /** Cheap enough to walk on demand: the cache holds one small file per icon in use. */
  async measureDiskCache(): Promise<{ files: number; bytes: number }> {
    let files = 0
    let bytes = 0
    try {
      const entries = await fs.readdir(this.cachePath, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue
        }
        files++
        bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size
      }
    } catch {
      // -> No cache directory yet, which is simply an empty cache
    }
    return { files, bytes }
  }

  /**
   * `<dataPath>/icons` -- the writeable data-volume directory an operator drops vendored/exported
   * Iconify collection JSON files into, one file per prefix, with no rebuild, redeploy or network
   * access needed. Read on every boot. See `docs/offline-deployment.md`.
   */
  sideloadPath(): string {
    // -> Falls back to `base.yml`'s default rather than requiring callers to have merged it in
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath || './data', 'icons')
  }

  /**
   * `backend/assets/icon-sets` -- the read-only, committed release-asset directory (as opposed to
   * `sideloadPath()`'s writeable data-volume one), holding icon sets vendored straight into the
   * repo/image so a fresh instance already has them without any operator or network action.
   * Generated by `scripts/vendor-icon-sets.ts` from the `@iconify-json/*` npm package(s).
   */
  vendoredIconSetsPath(): string {
    return path.join(CARDINAL.SERVERPATH, 'assets/icon-sets')
  }

  /**
   * Loads every `<prefix>.json` file under `dir` straight into the permanent record (the `icons`
   * table), the offline-vendored equivalent of `fetchIconsUpstream`'s API fetch. A missing directory
   * is not an error: most instances have nothing sideloaded, and this runs on every boot.
   *
   * Each file is a full Iconify collection export (`{ icons, aliases?, info? }`) -- NOT the per-icon
   * shape `writeDiskCache` writes; that tier stays untouched. The filename, not any `prefix` field
   * inside the file, names the set. There is no freshness gate: neither `icons` nor `iconSets`
   * carries an `updatedAt`, and the upstream path always-overwrites on conflict too, so a sideload
   * is last-write-wins on every boot.
   *
   * A file contributing at least one usable icon also upserts its `iconSets` row
   * (`onConflictDoNothing`, so a set already added with real upstream metadata through the admin
   * picker keeps that metadata) BEFORE its icons are written, since `icons.prefix` has a foreign key
   * on `iconSets.prefix`.
   *
   * @param dir Defaults to the operator-writable `sideloadPath()`; `init()` passes
   *   `vendoredIconSetsPath()`, so the committed release asset lands through this same path and
   *   stays just as overridable by a later fetch or operator sideload.
   */
  async sideloadFromDataPath(dir: string = this.sideloadPath()): Promise<{
    loaded: { prefix: string; iconCount: number }[]
    skipped: { prefix: string; error: string }[]
  }> {
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return { loaded: [], skipped: [] }
    }

    const loaded: { prefix: string; iconCount: number }[] = []
    const skipped: { prefix: string; error: string }[] = []

    for (const file of files) {
      const prefix = file.replace(/\.json$/, '')
      if (!PREFIX_PATTERN.test(prefix)) {
        skipped.push({ prefix, error: `"${prefix}" is not a valid icon set prefix` })
        continue
      }

      const flPath = path.join(dir, file)
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(flPath, 'utf8'))
      } catch (err: any) {
        skipped.push({ prefix, error: `invalid JSON: ${err.message}` })
        continue
      }
      const parsed = parseSideloadIconCollection(raw)
      if (!parsed.ok) {
        skipped.push({ prefix, error: parsed.error })
        continue
      }
      const collection = parsed.collection

      const names = [
        ...new Set([
          ...Object.keys(collection.icons ?? {}),
          ...Object.keys(collection.aliases ?? {})
        ])
      ]
      const resolved: { name: string; icon: IconifyIcon }[] = []
      for (const name of names) {
        if (!NAME_PATTERN.test(name)) {
          continue
        }
        const data = getIconData(collection, name)
        if (!data?.body || !isSafeIconBody(data.body)) {
          continue
        }
        resolved.push({ name, icon: data })
      }

      if (resolved.length < 1) {
        skipped.push({ prefix, error: 'no usable icons found in file' })
        continue
      }

      try {
        await CARDINAL.db
          .insert(iconSetsTable)
          .values({
            prefix,
            name: (collection.info as IconifyInfo | undefined)?.name ?? prefix,
            isEnabled: true,
            info: collection.info ?? {},
            refreshedAt: new Date()
          })
          .onConflictDoNothing()
        for (const { name, icon } of resolved) {
          await this.storeIcon(prefix, name, icon)
        }
      } catch (err: any) {
        skipped.push({ prefix, error: `could not be saved: ${err.message}` })
        continue
      }

      loaded.push({ prefix, iconCount: resolved.length })
      CARDINAL.logger.debug('icons', 'sideloaded icon set', { prefix, icons: resolved.length })
    }

    if (skipped.length > 0) {
      CARDINAL.logger.warn('icons', 'skipped icon sideload files', {
        skipped: skipped.length,
        files: skipped.map((s) => `${s.prefix} (${s.error})`).join(', ')
      })
    }
    return { loaded, skipped }
  }

  /**
   * @throws {IconNotFoundUpstreamError} When upstream has nothing for this request
   * @throws When offline mode is on, the request fails, or the response is otherwise malformed
   */
  async apiFetch(pathname: string): Promise<any> {
    if (CARDINAL.config.offline) {
      return Promise.reject(
        new Error('Cardinal.js is in offline mode and cannot reach the Iconify API.')
      )
    }
    const url = `${this.apiUrl}${pathname}`
    CARDINAL.logger.debug('icons', 'fetching upstream', { url })
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (resp.status === 404) {
      return Promise.reject(
        new IconNotFoundUpstreamError(`${this.apiUrl} has nothing for ${pathname}`)
      )
    }
    if (!resp.ok) {
      return Promise.reject(new Error(`${this.apiUrl} answered ${resp.status} for ${pathname}`))
    }
    const data = await resp.json()
    // -> The API answers an unknown prefix with the string `404` and a 200 status
    if (data === '404') {
      return Promise.reject(
        new IconNotFoundUpstreamError(`${this.apiUrl} has nothing for ${pathname}`)
      )
    }
    if (typeof data !== 'object' || data === null) {
      return Promise.reject(new Error(`${this.apiUrl} has nothing for ${pathname}`))
    }
    return data
  }

  rowToIcon(row: typeof iconsTable.$inferSelect): IconifyIcon {
    return {
      body: row.body,
      width: row.width,
      height: row.height,
      left: row.left,
      top: row.top,
      rotate: row.rotate,
      hFlip: row.hFlip,
      vFlip: row.vFlip
    }
  }

  async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cachePath, { recursive: true })
    } catch (err: any) {
      CARDINAL.logger.warn('icons', 'creating the icon cache directory failed', {
        path: this.cachePath,
        error: err
      })
    }
  }

  /**
   * Seed the icon sets a fresh instance starts with, deliberately network-free: the wiki has to
   * install without outbound access, so only the prefix and a name go in and the metadata is filled
   * in by the first refresh. `onConflictDoNothing` so a prefix already in the table cannot take
   * first-run seeding down with it.
   *
   * The sideload that follows materializes the vendored set's actual icons -- not just the empty
   * metadata row -- so the picker is fully usable offline with no admin action.
   */
  async init(): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the default icon sets')
    await CARDINAL.db
      .insert(iconSetsTable)
      .values(DEFAULT_SETS.map((set) => ({ ...set, isEnabled: true })))
      .onConflictDoNothing()
    await this.sideloadFromDataPath(this.vendoredIconSetsPath())
  }
}

export const icons = new Icons()
