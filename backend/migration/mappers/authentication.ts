import { escapeRegExp } from 'es-toolkit/string'
import { isPlainObject, pickDefined, transformConfig, unwrapKnexValue } from './shared.ts'
import type { authentication as authenticationTable } from '../../db/schema.ts'
import type { SourceRecord } from '../connector.ts'
import type { ConfigTransform } from './shared.ts'

/**
 * `mapAuthenticationRow(s)` — 2.5.x authentication strategies
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
 * `../report.ts`'s `KNOWN_3_0_AUTH_MODULES`); 2.x ships twenty-one. A source row whose
 * `strategyKey` isn't one of the sixteen survivors — resolved via `resolver.getModule()` returning
 * `null`, not a hardcoded list, so this mapper tracks whichever modules actually exist on disk rather
 * than a snapshot of them — has nowhere to land: not just its `config` (a remap target that exists),
 * but the row itself. Exactly like Feature 414's `needsProviderFallback()`/`ProviderFallbackFlag` for
 * source *users* on an unimplemented provider, this mapper does not write a row for it: it reports one
 * `status: 'unsupported'` entry in the result, carrying the source key and module, so the dry-run
 * report can show an administrator exactly what didn't come across and why.
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
 * ## One source, one row per module
 *
 * `authentication` carries no `siteId` — every row is instance-wide — and a 2.5.x source has at most
 * one row per module (`key` is that table's PK). An import runs one source into one fresh 3.0
 * instance, which has no existing rows to collide with, so there is no same-module collision for this
 * mapper to arbitrate: every valid row simply becomes its own row.
 */

// ---------------------------------------------------------------------------
// Source row shape
// ---------------------------------------------------------------------------

/**
 * One row as read from a 2.5.x `authentication` table
 * (`docs/migration/2.5x-source-schema.md`'s `## authentication` section). `order` is read but never
 * used — confirmed NO DESTINATION on 3.0's `authentication` table by both mapping docs.
 * `autoEnrollGroups` is likewise declared but never mapped: 3.0 has the column, but its values are
 * 2.x integer group ids and `settings` runs before `users`, so no imported group exists to remap them
 * onto (see `mapAuthenticationRow`'s own comment where it writes `[]`).
 *
 * `domainWhitelist`/`autoEnrollGroups` are typed `unknown`, not their eventual array shape, because
 * their wire shape depends on which `SourceConnector` kind produced this row:
 * `docs/migration/2.5x-export-bundle-format.md` confirms a live 2.x `authentication` row stores both
 * columns wrapped as `{ v: [...] }` (the same Objection/knex JSON-wrapper convention `configSvc`
 * uses for the `settings` table), while the export-bundle path already unwraps them to a bare array
 * before this mapper ever sees one. `./shared.ts`'s `unwrapKnexValue()` accepts either. `config` needs no
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
  const unwrapped = unwrapKnexValue(domainWhitelistRaw)
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
// Per-module config remap — the "key-by-key remap required, module by module" step
// `2.5x-to-3.0-mapping.md` calls for. Everything not picked here is simply absent from `incoming`;
// `buildConfig` fills it from the module's own default, and `validateConfig` skips undeclared keys
// entirely (`backend/models/authentication.ts`'s own comment: "Unknown keys are dropped by
// buildConfig rather than refused"), so there is no need to explicitly strip a 2.x-only prop like
// oidc's `skipUserProfile` — it is simply never picked, so it never reaches either function.
// ---------------------------------------------------------------------------

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
  google: (raw) => pickDefined(raw, ['clientId', 'clientSecret', 'hostedDomain']),
  github: (raw) => {
    const result = pickDefined(raw, ['clientId', 'clientSecret', 'allowedOrganization'])
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
    pickDefined(raw, ['clientId', 'clientSecret', 'authorizationURL', 'tokenURL', 'userInfoURL'])
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type AuthenticationRowStatus = 'created' | 'unsupported' | 'flagged'

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
}

/** Maps one 2.x `authentication` row. `mapAuthenticationRows` is the usual entry point; this is
 * exposed for a caller that wants to stream rows one at a time. */
export function mapAuthenticationRow(
  row: SourceAuthenticationRow,
  options: MapAuthenticationRowOptions
): AuthenticationRowResult {
  const { resolver } = options
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

  const incoming = transformConfig(CONFIG_TRANSFORMS, module, row.config)
  const validationError = resolver.validateConfig(module, incoming)
  if (validationError) {
    return {
      sourceKey,
      module,
      status: 'flagged',
      message: `config for module '${module}' failed validation after remapping: ${validationError}`
    }
  }

  const displayName = row.displayName?.trim() || mod.title

  // -> 2.5.x carried one combined flag (`selfRegistration`, source-side); 3.0 splits its target into
  //    `selfRegistration` (enforced only for a form-based module) and `autoProvision` (enforced only
  //    for a redirect-based one) -- see OpenProject WP #2130. Mirroring the source value onto
  //    both is what preserves whichever behavior the source row's module actually relied on, since
  //    the source has no way to say which of the two it meant and 3.0 only ever enforces the one that
  //    applies to the module the row lands on; the other stays a stored, inert value.
  const acceptsNewUsers = !!row.selfRegistration
  const newRow: NewAuthenticationRow = {
    module,
    isEnabled: !!row.isEnabled,
    displayName,
    selfRegistration: acceptsNewUsers,
    autoProvision: acceptsNewUsers,
    allowedEmailRegex: buildAllowedEmailRegex(row.domainWhitelist),
    // -> 2.x's own `autoEnrollGroups` names 2.x integer group ids, which have no 3.0 equivalent at
    //    the point this runs: `settings` deliberately runs before `users` (see `phases/settings.ts`),
    //    so no group has been imported yet and there is nothing to remap them onto.
    autoEnrollGroups: [],
    config: resolver.buildConfig(module, incoming, {})
  }

  return { sourceKey, module, status: 'created', row: newRow }
}

/** Maps every row from one source. */
export async function mapAuthenticationRows(
  rows: Iterable<SourceAuthenticationRow> | AsyncIterable<SourceAuthenticationRow>,
  options: MapAuthenticationRowOptions
): Promise<AuthenticationMappingResult> {
  const results: AuthenticationRowResult[] = []
  for await (const row of rows) {
    results.push(mapAuthenticationRow(row, options))
  }
  return { results }
}
