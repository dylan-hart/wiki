import { escapeRegExp } from 'es-toolkit/string'
import type { authentication as authenticationTable } from '../../db/schema.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * `mapAuthenticationRow(s)` (task 765 — "Authentication-strategy mapper with multi-source conflict
 * policy")
 *
 * A pure transform: no DB access, no side effects. Takes 2.5.x `authentication` table rows
 * (`docs/migration/2.5x-source-schema.md`'s `## authentication` section) and produces 3.0
 * `authentication` row inputs — directly insertable, config already built and validated — per
 * `docs/migration/2.5x-to-3.0-mapping.md`'s `## authentication` column mapping and
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 2 provider inventory.
 *
 * Every 2.x row's `config` is checked and completed the same way the live admin API does it
 * (`backend/api/authentication.ts`'s create route): `Authentication.validateConfig(module, incoming)`
 * first — a row whose config doesn't fit the target module's declared prop types is never silently
 * miscoerced, it comes back `flagged` — then `Authentication.buildConfig(module, incoming, {})` to
 * fill in every declared prop (module defaults for anything 2.x never had). This module never
 * constructs its own copy of that logic; it takes an `AuthModuleResolver` (the real
 * `WIKI.models.authentication` singleton satisfies it structurally) so the mapper and the model can
 * never drift apart on what a "valid" config is.
 *
 * ---
 *
 * ## Unsupported source modules (mirrors Feature 414's provider-fallback precedent)
 *
 * 3.0 ships sixteen authentication modules (`backend/modules/authentication/*`, see
 * `../unmappable.ts`'s `KNOWN_3_0_AUTH_MODULES`); 2.x ships twenty-one. A source row whose
 * `strategyKey` isn't one of the sixteen survivors — resolved via `resolver.getModule()` returning
 * `null`, not a hardcoded list, so this mapper tracks whichever modules actually exist on disk rather
 * than a snapshot of them — has nowhere to land: not just its `config` (a remap target that exists),
 * but the row itself. Exactly like Feature 414's `needsProviderFallback()`/`ProviderFallbackFlag` for
 * source *users* on an unimplemented provider, this mapper does not write a row for it: it reports one
 * `status: 'unsupported'` entry in the result, carrying the source key and module, for whichever future
 * dry-run report (Feature 421) wants to show an administrator exactly what didn't come across and why.
 *
 * ## Unverified config mappings
 *
 * `resolver.getModule()` resolving is necessary but not sufficient for a `config` blob to be safe to
 * carry across: `CONFIG_TRANSFORMS` below only has a real key-by-key remap for `local`/`google`/
 * `github`/`oidc` (`MODULES_WITH_VERIFIED_CONFIG_MAPPING`). A row for any other module — `ldap`/`saml`/
 * `cas`/`auth0`/`okta`/`gitlab`/`keycloak`/`microsoft`/`discord`/`slack`/`twitch`/`oauth2`, all real
 * 3.0 modules with no verified prop-name check yet — that carried a non-empty `config` comes back
 * `status: 'flagged'` instead of silently importing as an **enabled** strategy with an empty config
 * (no server URL, no bind DN, no certificate, no client secret): a broken login option an operator
 * would otherwise see reported as successfully created. A row with an *empty* config for one of these
 * modules has nothing to lose in the remap and still comes back `created` — the module itself is real,
 * only its `config` prop names are unverified. This is deliberately not a copy of `mappers/storage.ts`'s
 * gate: storage is safe because its transform coverage matches every module a 2.x row can name (`db`/
 * `gcs` deliberately absent, documented at `storage.ts:167-172`), which is not true here.
 *
 * ## Multi-source conflict policy
 *
 * `authentication` carries no `siteId` — every row is instance-wide. A single 2.5.x source already
 * has at most one row per module (`key` is that table's PK), but this mapper's caller may consolidate
 * *multiple* 2.5.x sources into one fresh 3.0 instance (that per-source PK gives no cross-source
 * uniqueness at all), and a fresh 3.0 install has no existing rows for either source's modules to
 * collide with — so the only place a same-module collision can happen is between two sources' rows
 * meeting each other here, in this mapper, not against anything already in the target database.
 *
 * `AuthenticationMapperState` is the caller's tool for detecting that: pass the *same* state object to
 * every call across every source being consolidated (each source's rows go through their own
 * `mapAuthenticationRows` call — the state, not the row list, is what threads the sources together),
 * and pick one of two explicit, tested policies for what happens the second time a module shows up:
 *
 * - `'additive'` (the default): every valid row becomes its own row. 3.0's schema has no uniqueness
 *   constraint on `authentication.module` and the admin UI already treats N concurrently-configured
 *   instances of the same module as a normal case (e.g. two `oidc` strategies for two tenants) — so
 *   dropping a second source's real, working provider config would be silent configuration loss with
 *   no way to reconstruct it afterward, which is worse than a slightly noisier strategy list. To keep
 *   the noise navigable, a `displayName` that would otherwise exactly collide with one already
 *   produced (from any source, any module — `authentication.displayName` has no per-module scope
 *   either) gets ` (2)`, ` (3)`, ... appended until it's unique.
 * - `'first-source-wins'`: the first row seen for a given module claims it; every later row for that
 *   same module, from any subsequent source, comes back `status: 'conflict-skipped'` — the row is real
 *   and was read correctly, it was just never written, which is why this is a distinct status from
 *   `'unsupported'` (no module exists at all) rather than reusing it.
 *
 * Neither policy is silently assumed: `conflictPolicy` is a required-with-default option on
 * `mapAuthenticationRows`/`mapAuthenticationRow`, so a caller sees the choice at the call site, and
 * both branches are exercised by this module's tests — not an implicit last-write-wins on whichever
 * row an importer happened to process last.
 */

// ---------------------------------------------------------------------------
// Source row shape
// ---------------------------------------------------------------------------

/**
 * One row as read from a 2.5.x `authentication` table
 * (`docs/migration/2.5x-source-schema.md`'s `## authentication` section). `order` is read but never
 * used — confirmed NO DESTINATION on 3.0's `authentication` table by both mapping docs.
 *
 * `domainWhitelist`/`autoEnrollGroups` are typed `unknown`, not their eventual array shape, because
 * their wire shape depends on which `SourceConnector` kind produced this row:
 * `docs/migration/2.5x-export-bundle-format.md` confirms a live 2.x `authentication` row stores both
 * columns wrapped as `{ v: [...] }` (the same Objection/knex JSON-wrapper convention `configSvc`
 * uses for the `settings` table), while the export-bundle path already unwraps them to a bare array
 * before this mapper ever sees one. `unwrapMaybeWrapped()` below accepts either. `config` needs no
 * such handling — confirmed (same doc, and the vendored `authentication.js` resolver's write path)
 * to always be a plain object on both source kinds.
 */
export interface SourceAuthenticationRow extends SourceRecord {
  key: string
  isEnabled: boolean
  config: unknown
  selfRegistration: boolean
  domainWhitelist: unknown
  autoEnrollGroups: unknown
  strategyKey: string
  displayName: string
}

/** What `authenticationTable` actually accepts on insert — the shape this mapper produces for every
 * `created` row. */
export type NewAuthenticationRow = typeof authenticationTable.$inferInsert

// ---------------------------------------------------------------------------
// Model dependency — the real `WIKI.models.authentication` singleton satisfies this structurally.
// Kept as a narrow interface (rather than importing the class) so this mapper is unit-testable
// without a live DB: `getModule`/`buildConfig`/`validateConfig` never touch `WIKI.db`, only
// `WIKI.data.authentication` (populated from disk by `refreshStrategiesFromDisk()`), so a test can
// wire the real singleton against the real `backend/modules/authentication/*/definition.yml` files
// with no database at all.
// ---------------------------------------------------------------------------

export interface AuthModuleResolver {
  /** `null` when no module on disk declares this key — the unsupported-module signal this mapper
   * reports on rather than guessing at. */
  getModule(key: string): { title: string } | null
  buildConfig(
    moduleKey: string,
    incoming?: Record<string, any>,
    existing?: Record<string, any>
  ): Record<string, any>
  /** The reason `incoming` doesn't fit the module's declared props, or `null` when it's fine. */
  validateConfig(moduleKey: string, incoming?: Record<string, any>): string | null
}

// ---------------------------------------------------------------------------
// domainWhitelist -> allowedEmailRegex
// ---------------------------------------------------------------------------

/** Undoes the `{ v: <value> }` wrapping a raw-Postgres-sourced `domainWhitelist`/`autoEnrollGroups`
 * column carries (see the module doc); a bare array (the export-bundle shape) passes through
 * unchanged. */
function unwrapMaybeWrapped(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'v' in (value as Record<string, unknown>)
  ) {
    return (value as Record<string, unknown>).v
  }
  return value
}

/**
 * Compiles a 2.x `domainWhitelist` (an explicit list of allowed email domains) into the single
 * anchored regex string 3.0's `authentication.allowedEmailRegex` stores.
 *
 * 2.x's own check (`server/models/users.js`, vendored 2026-08-18) is an *exact* match against the
 * substring after the final `@`: `_.includes(domainWhitelist, _.last(email.split('@')))` — not a
 * suffix or subdomain match, so `example.com` on the whitelist does not admit `user@sub.example.com`.
 * `backend/models/users.ts:1202-1206` evaluates the compiled result as `new RegExp(pattern).test(email)`
 * against an already-lowercased, already-trimmed address with **no anchoring of its own** — an
 * unanchored `example\.com` would match `user@notexample.com.evil.org` as a substring, which is not
 * what 2.x's exact check meant. This function anchors explicitly (`^[^@]+@(...)$`, one `@`, entire
 * domain) so the compiled regex reproduces 2.x's exact-match semantics instead of accidentally
 * loosening them, and lower-cases each domain to match the lowercased address it will be tested
 * against.
 *
 * An empty (or absent) whitelist compiles to `''`, matching both sides' "no restriction" meaning:
 * 2.x only enforces the check when `domainWhitelist.length > 0`, and 3.0's own login path only tests
 * `allowedEmailRegex` `if (strategy.allowedEmailRegex)` — falsy (empty string) skips the check
 * entirely.
 */
export function buildAllowedEmailRegex(domainWhitelistRaw: unknown): string {
  const unwrapped = unwrapMaybeWrapped(domainWhitelistRaw)
  const domains = Array.isArray(unwrapped)
    ? unwrapped.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : []
  if (domains.length === 0) {
    return ''
  }
  const alternation = domains.map((d) => escapeRegExp(d.trim().toLowerCase())).join('|')
  return `^[^@]+@(${alternation})$`
}

// ---------------------------------------------------------------------------
// autoEnrollGroups: 2.x integer group ids -> 3.0 group UUIDs
// ---------------------------------------------------------------------------

/**
 * Remaps 2.x integer group ids onto 3.0 group UUIDs via a caller-supplied `groupIdMap` — the same
 * old-id -> new-UUID bookkeeping `2.5x-to-3.0-mapping.md`'s `autoEnrollGroups` row calls for. An id
 * with no entry in the map (the group wasn't imported, or hasn't been yet — this mapper has no DB
 * access to check) is dropped rather than blocking the whole row: `autoEnrollGroups` is an
 * enhancement (accounts still get created without it), not a field whose absence makes the row
 * unusable, so a caller that hasn't run the groups importer yet still gets a valid `authentication`
 * row back, just with an empty (or partial) `autoEnrollGroups`.
 */
export function remapAutoEnrollGroups(
  autoEnrollGroupsRaw: unknown,
  groupIdMap: ReadonlyMap<number, string>
): string[] {
  const unwrapped = unwrapMaybeWrapped(autoEnrollGroupsRaw)
  if (!Array.isArray(unwrapped)) {
    return []
  }
  const result: string[] = []
  for (const entry of unwrapped) {
    const sourceId =
      typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : NaN
    if (!Number.isInteger(sourceId)) {
      continue
    }
    const targetId = groupIdMap.get(sourceId)
    if (targetId) {
      result.push(targetId)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Per-module config remap — the "key-by-key remap required, module by module" step
// `2.5x-to-3.0-mapping.md` calls for. Everything not picked here is simply absent from `incoming`;
// `buildConfig` fills it from the module's own default, and `validateConfig` skips undeclared keys
// entirely (`backend/models/authentication.ts`'s own comment: "Unknown keys are dropped by
// buildConfig rather than refused"), so there is no need to explicitly strip a 2.x-only prop like
// oidc's `skipUserProfile` — it is simply never picked, so it never reaches either function.
// ---------------------------------------------------------------------------

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source && source[key] !== undefined) {
      result[key] = source[key]
    }
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type ConfigTransform = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s "four surviving modules' config
 * prop-name check" (Part 2), applied. `local` has no 2.x-configurable props at all (2.x's `local`
 * `definition.yml` declares `props: {}`), so nothing is ever picked for it — its three 3.0 props
 * (`enforceTfa`, `emailValidation`, `allowForgotPassword`) are new capabilities that always take
 * their module defaults on import, never a 2.x value.
 */
/**
 * Modules `CONFIG_TRANSFORMS` actually has a verified key-by-key remap for. Kept as its own named set
 * (rather than reading `CONFIG_TRANSFORMS`'s keys where needed) so the "is this module's config
 * mapping verified" question reads as its own named check at each call site — see the module doc's
 * "Unverified config mappings" section for why every other real 3.0 module still gets flagged rather
 * than silently importing an empty config as enabled.
 */
const MODULES_WITH_VERIFIED_CONFIG_MAPPING = new Set(['local', 'google', 'github', 'oidc'])

function hasNonEmptyConfig(rawConfig: unknown): boolean {
  return isPlainObject(rawConfig) && Object.keys(rawConfig).length > 0
}

const CONFIG_TRANSFORMS: Record<string, ConfigTransform> = {
  local: () => ({}),
  google: (raw) => pick(raw, ['clientId', 'clientSecret', 'hostedDomain']),
  github: (raw) => {
    const result = pick(raw, ['clientId', 'clientSecret', 'allowedOrganization'])
    // -> Structural collapse, not a rename: 2.x's useEnterprise (boolean) + enterpriseDomain (string)
    //    become 3.0's single enterpriseHost field, whose non-empty presence is what the boolean used
    //    to gate explicitly.
    if (
      raw.useEnterprise === true &&
      typeof raw.enterpriseDomain === 'string' &&
      raw.enterpriseDomain.length > 0
    ) {
      result.enterpriseHost = raw.enterpriseDomain
    }
    return result
  },
  oidc: (raw) =>
    pick(raw, ['clientId', 'clientSecret', 'authorizationURL', 'tokenURL', 'userInfoURL'])
}

/**
 * The only modules whose `CONFIG_TRANSFORMS` entry has actually been checked key-by-key against a
 * real 2.x `definition.yml` (`docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 2).
 * `resolver.getModule(module)` resolves for all sixteen 3.0 authentication modules on disk — far more
 * than the four this mapper has a real transform for — so a module missing here is not "no config",
 * it is "config nobody has verified how to remap yet". Deliberately **not** a copy of
 * `mappers/storage.ts`'s `KNOWN_3_0_STORAGE_MODULES` gate: storage's transform coverage matches every
 * module a 2.x row can name (`db`/`gcs` deliberately absent because no 2.x row can ever carry that
 * key — see that module's own doc comment), which is not true here. A `saml`/`ldap`/`cas`/`auth0`/
 * `okta`/`gitlab`/`keycloak`/`microsoft`/`discord`/`slack`/`twitch`/`oauth2` row is a real, resolvable
 * module with real, still-unmapped config — silently discarding that config and importing the
 * strategy enabled would hand end users a broken login option reported as a successful create.
 */
const MODULES_WITH_VERIFIED_CONFIG_MAPPING = new Set(Object.keys(CONFIG_TRANSFORMS))

function transformConfig(module: string, rawConfig: unknown): Record<string, unknown> {
  const raw = isPlainObject(rawConfig) ? rawConfig : {}
  const transform = CONFIG_TRANSFORMS[module]
  return transform ? transform(raw) : {}
}

/** A source row's `config` is "non-empty" — worth flagging when its module has no verified mapping —
 * whenever it's a plain object with at least one own key. `null`/`undefined`/an array/a row that
 * never had a `config` at all carries nothing to lose, so it's safe to import with the (empty,
 * fully-defaulted) config every unverified module would otherwise get silently. */
function hasNonEmptyConfig(rawConfig: unknown): boolean {
  return isPlainObject(rawConfig) && Object.keys(rawConfig).length > 0
}

// ---------------------------------------------------------------------------
// Multi-source conflict policy
// ---------------------------------------------------------------------------

export type ConflictPolicy = 'additive' | 'first-source-wins'

/**
 * Threads consolidation state across every `mapAuthenticationRows`/`mapAuthenticationRow` call that
 * belongs to the same import run — one call per source, the *same* state object passed to each. See
 * the module doc's "Multi-source conflict policy" section for what each policy does with it.
 */
export interface AuthenticationMapperState {
  /** Every `displayName` already produced by a `created` row, from any source, any module — used by
   * `'additive'` to disambiguate a colliding one. */
  usedDisplayNames: Set<string>
  /** Every module a `created` row already exists for, from any source — used by `'first-source-wins'`
   * to detect a later source reconfiguring the same module. */
  claimedModules: Set<string>
}

export function createAuthenticationMapperState(): AuthenticationMapperState {
  return { usedDisplayNames: new Set(), claimedModules: new Set() }
}

function disambiguateDisplayName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base
  }
  let n = 2
  while (used.has(`${base} (${n})`)) {
    n++
  }
  return `${base} (${n})`
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type AuthenticationRowStatus = 'created' | 'unsupported' | 'flagged' | 'conflict-skipped'

export interface AuthenticationRowResult {
  /** The source row's 2.x `key` (that table's PK) — unique within one source, not across sources. */
  sourceKey: string
  /** The resolved module key (2.x `strategyKey`, falling back to `key` — see `resolveModuleKey`),
   * present even for an `unsupported` row so a report can say which module was skipped. */
  module: string
  status: AuthenticationRowStatus
  /** Present only when `status === 'created'`. */
  row?: NewAuthenticationRow
  /** Required for every non-`created` status. */
  message?: string
}

export interface AuthenticationMappingResult {
  /** One entry per source row, in read order, whatever its outcome. */
  results: AuthenticationRowResult[]
  /** Convenience: just the rows actually ready to insert, in order — what an importer's writer loop
   * iterates. */
  createdRows: NewAuthenticationRow[]
}

/** 2.x `strategyKey` (added `2.5.1.js`, backfilled from `key` on upgrade — see
 * `docs/migration/2.5x-source-schema.md`) is the module directory name; a pre-2.5.1 dump that
 * somehow still had an empty `strategyKey` falls back to the row's own `key`, which is what
 * `strategyKey` was backfilled from in the first place. */
function resolveModuleKey(row: SourceAuthenticationRow): string {
  const strategyKey = typeof row.strategyKey === 'string' ? row.strategyKey.trim() : ''
  if (strategyKey.length > 0) {
    return strategyKey
  }
  return typeof row.key === 'string' ? row.key : ''
}

export interface MapAuthenticationRowOptions {
  resolver: AuthModuleResolver
  /** @default 'additive' */
  conflictPolicy?: ConflictPolicy
  /** @default an empty map — every `autoEnrollGroups` entry is dropped rather than blocking the row. */
  groupIdMap?: ReadonlyMap<number, string>
  /** @default a fresh, single-call state. Pass the same state across every source's call to actually
   * exercise the conflict policy — see the module doc. */
  state?: AuthenticationMapperState
}

/** Maps one 2.x `authentication` row. See the module doc for the full policy; `mapAuthenticationRows`
 * is the usual entry point, this is exposed for a caller that wants to stream rows one at a time. */
export function mapAuthenticationRow(
  row: SourceAuthenticationRow,
  options: MapAuthenticationRowOptions
): AuthenticationRowResult {
  const {
    resolver,
    conflictPolicy = 'additive',
    groupIdMap = new Map(),
    state = createAuthenticationMapperState()
  } = options
  const sourceKey = typeof row.key === 'string' ? row.key : String(row.key ?? '?')
  const module = resolveModuleKey(row)

  const mod = module.length > 0 ? resolver.getModule(module) : null
  if (!mod) {
    return {
      sourceKey,
      module,
      status: 'unsupported',
      message:
        module.length > 0
          ? `source module '${module}' has no 3.0 authentication module (backend/modules/authentication/${module}/definition.yml does not exist) — see docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory`
          : 'source row has no strategyKey/key to resolve a module from'
    }
  }

  if (!MODULES_WITH_VERIFIED_CONFIG_MAPPING.has(module) && hasNonEmptyConfig(row.config)) {
    return {
      sourceKey,
      module,
      status: 'flagged',
      message: `module '${module}' has no verified config prop-name mapping yet — this source row's config was not carried across; see docs/migration/2.5x-settings-auth-storage-field-mapping.md's "The four originally-surviving modules' config prop-name check" section`
    }
  }

  const incoming = transformConfig(module, row.config)
  const validationError = resolver.validateConfig(module, incoming)
  if (validationError) {
    return {
      sourceKey,
      module,
      status: 'flagged',
      message: `config for module '${module}' failed validation after remapping: ${validationError}`
    }
  }

  if (conflictPolicy === 'first-source-wins' && state.claimedModules.has(module)) {
    return {
      sourceKey,
      module,
      status: 'conflict-skipped',
      message: `module '${module}' was already configured by an earlier source (first-source-wins policy) — this row was skipped, not merged or overwritten`
    }
  }

  const baseDisplayName = row.displayName?.trim() || mod.title
  const displayName =
    conflictPolicy === 'additive'
      ? disambiguateDisplayName(baseDisplayName, state.usedDisplayNames)
      : baseDisplayName

  const newRow: NewAuthenticationRow = {
    module,
    isEnabled: !!row.isEnabled,
    displayName,
    registration: !!row.selfRegistration,
    allowedEmailRegex: buildAllowedEmailRegex(row.domainWhitelist),
    autoEnrollGroups: remapAutoEnrollGroups(row.autoEnrollGroups, groupIdMap),
    config: resolver.buildConfig(module, incoming, {})
  }

  state.usedDisplayNames.add(displayName)
  state.claimedModules.add(module)

  return { sourceKey, module, status: 'created', row: newRow }
}

/** Maps every row from one source. Pass the same `state` (via `options`) across multiple calls to
 * consolidate multiple sources under one conflict policy — see the module doc. */
export async function mapAuthenticationRows(
  rows: Iterable<SourceAuthenticationRow> | AsyncIterable<SourceAuthenticationRow>,
  options: MapAuthenticationRowOptions
): Promise<AuthenticationMappingResult> {
  const results: AuthenticationRowResult[] = []
  const createdRows: NewAuthenticationRow[] = []
  for await (const row of rows) {
    const result = mapAuthenticationRow(row, options)
    results.push(result)
    if (result.status === 'created' && result.row) {
      createdRows.push(result.row)
    }
  }
  return { results, createdRows }
}
