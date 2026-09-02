import { isPlainObject, pickPresent, unwrapKnexValue } from './shared.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * `mapSiteSettings` (task 764 — "Site-settings mapper: title/theme/branding/locale/mail")
 *
 * A pure transform: no DB access, no side effects. Takes a parsed dump of a 2.5.x install's
 * `settings` table rows and produces (a) a `sites.config` JSONB patch, deep-mergeable onto
 * `Sites.createSite`'s own defaults the exact same way that method already merges an explicit
 * `config` argument — `toMerged(defaults, config)` (`backend/models/sites.ts:90-195`, `es-toolkit`) —
 * and (b) the subset of rows that belong on 3.0's instance-wide `settings` table instead, one entry
 * per row key, each itself `toMerged`-mergeable onto that row's own default
 * (`backend/models/settings.ts`'s `Settings.init()`).
 *
 * The importer engine that will actually apply these (Feature 421, not yet built) owns reading a
 * source and calling `toMerged` for real; this module only computes what to merge.
 *
 * Scope, per the task description and `docs/migration/2.5x-settings-auth-storage-field-mapping.md`
 * (task 763's field-by-field spec, the source of every mapping below):
 *
 * - `sites.config`: `title`, `description` (from 2.x `seo.description`), `company`,
 *   `contentLicense`, `logoUrl`, `theme` (only the sub-fields with a 3.0 destination — colors and
 *   fonts have no 2.x source and are therefore never present in the patch), `locales.primary` (from
 *   2.x `lang.code`).
 * - instance-wide `settings`: `mail` (near-verbatim rename-free copy) and `security` (2.x's
 *   `security.*`, including its two polarity-inverted booleans, folded together with 2.x's
 *   `uploads.*` — which the field-mapping doc's biggest surprise moves onto this same 3.0 `security`
 *   row, not onto the identically-named but unrelated `sites.config.uploads`).
 *
 * Everything else the field-mapping doc catalogs (`features`, `robots`, `footerExtra`,
 * `pageExtensions`, `auth.autoLogin`/`hideLocal`, `enforce2FA`, the `loginBg` asset, `api`, the
 * `auth` certs/secret settings row, `flags`, `metrics`) is out of this task's named scope — either a
 * sibling task's concern (auth strategies: task 765; storage: task 767) or left, same as the doc
 * itself does, as documented NO DESTINATION / follow-up scope.
 *
 * A 2.x key that is absent from `rows` altogether (a source that never wrote it — the doc's `mail`
 * "never configured" example is the task description's own worked case) is never synthesized here:
 * an absent key means an absent field/section in the returned patch, so a downstream `toMerged`
 * leaves 3.0's own default completely alone rather than being overwritten with an empty string.
 */

/**
 * One row as read from a 2.5.x install's `settings` table: `key`/`value`
 * (`docs/migration/2.5x-source-schema.md`'s `## settings` section — the third column, `updatedAt`,
 * carries nothing this mapper needs). `value` is exactly what a raw row carries: 2.x's own
 * `configSvc.saveToDb()` wraps every non-plain-object value as `{ v: <value> }`
 * (`server/core/config.js`, vendored under `docs/migration/vendor/2x-settings/`) and stores plain
 * objects (`mail`, `theming`, `lang`, `seo`, `security`, `uploads`, ...) unwrapped — `./shared.ts`'s
 * `unwrapKnexValue()` undoes exactly that, mirroring the identical unwrap 3.0's own
 * `Settings.getConfig()` already does (`backend/models/settings.ts`).
 */
export interface SiteSettingsSourceRow extends SourceRecord {
  key: string
  value: unknown
}

export interface SiteSettingsMapping {
  /** Deep-mergeable via `toMerged(defaults, siteConfigPatch)` onto `Sites.createSite`'s default
   * `config` object. Only ever carries fields this source actually supplied. */
  siteConfigPatch: Record<string, any>
  /** One entry per instance-wide 3.0 `settings` row this source's data affects, each itself
   * deep-mergeable via `toMerged(defaults, patch)` onto that row's own `Settings.init()` default.
   * A key is present here only when the source had at least one field for that row — see the module
   * doc comment on why an absent source key must not appear here even as `{}`. */
  instanceSettings: {
    mail?: Record<string, any>
    security?: Record<string, any>
  }
}

const MAIL_FIELDS = [
  'senderName',
  'senderEmail',
  'host',
  'port',
  'name',
  'secure',
  'verifySSL',
  'user',
  'pass',
  'useDKIM',
  'dkimDomainName',
  'dkimKeySelector',
  'dkimPrivateKey'
] as const

/** 2.x `security.*` field name -> 3.0 `settings.security.*` field name. `securityOpenRedirect` and
 * `securityIframe` also need their boolean polarity inverted — handled separately, not through this
 * table, since a rename table has nowhere to express "and negate it". */
const SECURITY_RENAMES: Record<string, string> = {
  securityReferrerPolicy: 'enforceSameOriginReferrerPolicy',
  securityTrustProxy: 'trustProxy',
  securityHSTS: 'enforceHsts',
  securityHSTSDuration: 'hstsDuration',
  securityCSP: 'enforceCsp',
  securityCSPDirectives: 'cspDirectives'
}

const SECURITY_INVERTED_RENAMES: Record<string, string> = {
  securityOpenRedirect: 'disallowOpenRedirect',
  securityIframe: 'disallowIframe'
}

/** 2.x `uploads.*` field name -> 3.0 `settings.security.*` field name — the field-mapping doc's
 * "biggest scope surprise": these move tables (2.x `uploads` -> 3.0 `security`), not just names.
 * 2.x's `maxFiles` has no 3.0 counterpart to map to — `uploadMaxFiles` was a dead setting nothing
 * enforced (OpenProject #1360/#2152/#2174, 2026-08-24 security audit), deleted rather than kept as
 * inert config a fresh 3.0 install has no use for. `scanSVG` maps straight across: `uploadScanSVG`
 * is enforced (OpenProject #2170), so a migrated instance's existing choice carries over.
 */
const UPLOADS_TO_SECURITY_RENAMES: Record<string, string> = {
  maxFileSize: 'uploadMaxFileSize',
  scanSVG: 'uploadScanSVG',
  forceDownload: 'forceAssetDownload'
}

export function mapSiteSettings(rows: readonly SiteSettingsSourceRow[]): SiteSettingsMapping {
  const byKey = new Map<string, unknown>()
  for (const row of rows) {
    byKey.set(row.key, unwrapKnexValue(row.value))
  }

  const siteConfigPatch: Record<string, any> = {}

  const title = byKey.get('title')
  if (typeof title === 'string') {
    siteConfigPatch.title = title
  }

  const company = byKey.get('company')
  if (typeof company === 'string') {
    siteConfigPatch.company = company
  }

  const contentLicense = byKey.get('contentLicense')
  if (typeof contentLicense === 'string') {
    siteConfigPatch.contentLicense = contentLicense
  }

  const logoUrl = byKey.get('logoUrl')
  if (typeof logoUrl === 'string') {
    siteConfigPatch.logoUrl = logoUrl
  }

  const seo = byKey.get('seo')
  if (isPlainObject(seo) && typeof seo.description === 'string') {
    siteConfigPatch.description = seo.description
  }

  const theming = byKey.get('theming')
  if (isPlainObject(theming)) {
    const theme: Record<string, unknown> = pickPresent(theming, [
      'tocPosition',
      'injectCSS',
      'injectHead',
      'injectBody'
    ])
    if ('darkMode' in theming) {
      theme.dark = theming.darkMode
    }
    if (Object.keys(theme).length > 0) {
      siteConfigPatch.theme = theme
    }
  }

  const lang = byKey.get('lang')
  if (isPlainObject(lang) && typeof lang.code === 'string') {
    siteConfigPatch.locales = { primary: lang.code }
  }

  const instanceSettings: SiteSettingsMapping['instanceSettings'] = {}

  const mail = byKey.get('mail')
  if (isPlainObject(mail)) {
    const mailPatch = pickPresent(mail, MAIL_FIELDS)
    if (Object.keys(mailPatch).length > 0) {
      instanceSettings.mail = mailPatch
    }
  }

  const security: Record<string, unknown> = {}

  const securityRow = byKey.get('security')
  if (isPlainObject(securityRow)) {
    for (const [from, to] of Object.entries(SECURITY_RENAMES)) {
      if (from in securityRow) {
        security[to] = securityRow[from]
      }
    }
    for (const [from, to] of Object.entries(SECURITY_INVERTED_RENAMES)) {
      if (from in securityRow) {
        security[to] = !securityRow[from]
      }
    }
  }

  const uploads = byKey.get('uploads')
  if (isPlainObject(uploads)) {
    for (const [from, to] of Object.entries(UPLOADS_TO_SECURITY_RENAMES)) {
      if (from in uploads) {
        security[to] = uploads[from]
      }
    }
  }

  if (Object.keys(security).length > 0) {
    instanceSettings.security = security
  }

  return { siteConfigPatch, instanceSettings }
}
