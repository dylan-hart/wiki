import { escapeRegExp } from 'es-toolkit/string'
import { isPlainObject, pickDefined, transformConfig, unwrapKnexValue } from './shared.ts'
import type { authentication as authenticationTable } from '../../db/schema.ts'
import type { SourceRecord } from '../connector.ts'
import type { ConfigTransform } from './shared.ts'

/**
 * 2.5.x `authentication` rows -> 3.0 `authentication` row inputs. A pure transform: no DB access, no
 * side effects.
 *
 * Every row's `config` is checked and completed the way the live admin API does it
 * (`api/auth/strategies.ts`'s create route): `validateConfig` first — a config that does not fit the
 * target module's declared props comes back `flagged` rather than silently miscoerced — then
 * `buildConfig` to fill every declared prop from the module's own defaults. Both come from the
 * injected `AuthModuleResolver`, so the mapper and the model cannot drift on what a valid config is.
 *
 * ## Unsupported source modules
 *
 * 2.x ships more authentication modules than 3.0 does. A row whose module does not resolve through
 * `resolver.getModule()` — read off disk, not from a hardcoded list — has nowhere to land, so no row
 * is written at all: it comes back `status: 'unsupported'` for the dry-run report to show.
 *
 * ## Unverified config mappings
 *
 * Resolving is necessary but not sufficient for a `config` to be safe to carry across:
 * `CONFIG_TRANSFORMS` has a verified key-by-key remap only for `local`, `google`, `github` and
 * `oidc`. A row for any other module carrying a non-empty config comes back `flagged` instead of
 * importing as an **enabled** strategy with an empty config — no server URL, no certificate, no
 * client secret — which an operator would see reported as successfully created. An empty config has
 * nothing to lose in the remap, so it still comes back `created`. `mappers/storage.ts` gates
 * differently because its transform coverage matches every module a 2.x row can name; this one's
 * does not.
 *
 * A 2.5.x source has at most one row per module (`key` is that table's PK) and `authentication` has
 * no `siteId`, so there is no same-module collision for this mapper to arbitrate.
 */

/**
 * One row as read from a 2.5.x `authentication` table. `order` and `autoEnrollGroups` are declared
 * but never mapped — `order` has no 3.0 destination, and `autoEnrollGroups` holds 2.x integer group
 * ids that nothing has imported yet when this runs.
 *
 * `domainWhitelist`/`autoEnrollGroups` are typed `unknown` rather than their eventual array shape
 * because the wire shape depends on the `SourceConnector`: a live 2.x row wraps both columns as
 * `{ v: [...] }` (Objection/knex's JSON-wrapper convention), while the export-bundle path has
 * already unwrapped them to a bare array. `./shared.ts`'s `unwrapKnexValue()` accepts either.
 * `config` is a plain object on both source kinds and needs no such handling.
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

export type NewAuthenticationRow = typeof authenticationTable.$inferInsert

/** The real `CARDINAL.models.authentication` singleton satisfies this structurally. Kept as a narrow
 * interface rather than an import of the class because none of the three methods touches
 * `CARDINAL.db` — only `CARDINAL.data.authentication` — so a test can wire the real singleton
 * against the real on-disk `definition.yml` files with no database. */
export interface AuthModuleResolver {
  /** `null` when no module on disk declares this key. */
  getModule(key: string): { title: string } | null
  buildConfig(
    moduleKey: string,
    incoming?: Record<string, any>,
    existing?: Record<string, any>
  ): Record<string, any>
  /** The reason `incoming` doesn't fit the module's declared props, or `null` when it's fine. */
  validateConfig(moduleKey: string, incoming?: Record<string, any>): string | null
}

/**
 * Compiles a 2.x `domainWhitelist` into the single regex string 3.0's
 * `authentication.allowedEmailRegex` stores.
 *
 * 2.x's own check is an *exact* match on the substring after the final `@`
 * (`_.includes(domainWhitelist, _.last(email.split('@')))`), so `example.com` does not admit
 * `user@sub.example.com`. The 3.0 login path tests the stored pattern with no anchoring of its own,
 * where an unanchored `example\.com` would match `user@notexample.com.evil.org` — hence the explicit
 * `^[^@]+@(...)$`. Domains are lower-cased to match the already-lowercased address tested against.
 *
 * An empty whitelist compiles to `''`, which is "no restriction" on both sides: 2.x enforces only
 * when the list is non-empty, and 3.0 skips the check on a falsy pattern.
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

/**
 * Modules `CONFIG_TRANSFORMS` has a verified key-by-key remap for. Its own named set, rather than
 * `CONFIG_TRANSFORMS`'s key list, so "is this module's config mapping verified" reads as a named
 * check at each call site — see the module doc's "Unverified config mappings".
 */
const MODULES_WITH_VERIFIED_CONFIG_MAPPING = new Set(['local', 'google', 'github', 'oidc'])

function hasNonEmptyConfig(rawConfig: unknown): boolean {
  return isPlainObject(rawConfig) && Object.keys(rawConfig).length > 0
}

// A prop not picked here is simply absent from `incoming`: `buildConfig` fills it from the module's
// own default and `validateConfig` ignores undeclared keys, so a 2.x-only prop needs no explicit
// strip — it never reaches either function.
const CONFIG_TRANSFORMS: Record<string, ConfigTransform> = {
  // -> 2.x's `local` declares `props: {}`, so there is nothing to carry over; 3.0's three props are
  //    new capabilities that always take their module defaults on import.
  local: () => ({}),
  google: (raw) => pickDefined(raw, ['clientId', 'clientSecret', 'hostedDomain']),
  github: (raw) => {
    const result = pickDefined(raw, ['clientId', 'clientSecret', 'allowedOrganization'])
    // -> Structural collapse, not a rename: 2.x's useEnterprise + enterpriseDomain become 3.0's
    //    single enterpriseHost, whose non-empty presence is what the boolean used to gate.
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

export type AuthenticationRowStatus = 'created' | 'unsupported' | 'flagged'

export interface AuthenticationRowResult {
  sourceKey: string
  /** The resolved module key, present even for an `unsupported` row so a report can name which
   * module was skipped. */
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

/** 2.x's `strategyKey` (added in 2.5.1, backfilled from `key` on upgrade) is the module directory
 * name; a pre-2.5.1 dump with an empty one falls back to `key`, which it was backfilled from. */
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

/** Exposed separately from `mapAuthenticationRows` for a caller streaming rows one at a time. */
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

  // -> 2.5.x's single `selfRegistration` splits into 3.0's `selfRegistration` (enforced for a
  //    form-based module) and `autoProvision` (for a redirect-based one). The source cannot say
  //    which it meant, so both mirror it: 3.0 enforces only the one that applies to the module this
  //    row lands on, and the other stays stored and inert.
  const acceptsNewUsers = !!row.selfRegistration
  const newRow: NewAuthenticationRow = {
    module,
    isEnabled: !!row.isEnabled,
    displayName,
    selfRegistration: acceptsNewUsers,
    autoProvision: acceptsNewUsers,
    allowedEmailRegex: buildAllowedEmailRegex(row.domainWhitelist),
    // -> 2.x's `autoEnrollGroups` names 2.x integer group ids with nothing to remap onto here: the
    //    `settings` phase deliberately runs before `users`, so no group has been imported yet.
    autoEnrollGroups: [],
    config: resolver.buildConfig(module, incoming, {})
  }

  return { sourceKey, module, status: 'created', row: newRow }
}

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
