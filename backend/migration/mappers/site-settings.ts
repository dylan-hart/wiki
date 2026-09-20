import { isPlainObject, pickPresent, unwrapKnexValue } from './shared.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * `mapSiteSettings` — site title/theme/branding/locale/mail
 *
 * A pure transform: no DB access, no side effects. Takes a parsed dump of a 2.5.x install's
 * `settings` table rows and produces (a) a `sites.config` JSONB patch, deep-mergeable via
 * `toMerged(defaults, patch)` onto `Sites.createSite`'s own defaults, and (b) the subset of rows
 * belonging on 3.0's instance-wide `settings` table instead, one entry per row key, each mergeable
 * the same way onto that row's own `Settings.init()` default. `phases/settings.ts` owns reading a
 * source and doing the merge for real; this module only computes what to merge.
 *
 * What lands where (`docs/migration/2.5x-settings-auth-storage-field-mapping.md` is the
 * field-by-field spec behind every mapping):
 *
 * - `sites.config`: `title`, `description` (from 2.x `seo.description`), `company`,
 *   `contentLicense`, `logoUrl`, `theme` (only the sub-fields with a 3.0 destination — colors and
 *   fonts have no 2.x source and are therefore never present in the patch), `locales.primary` (from
 *   2.x `lang.code`).
 * - instance-wide `settings`: `mail` (a rename-free copy) and `security` — 2.x's `security.*`,
 *   including its two polarity-inverted booleans, folded together with 2.x's `uploads.*`, which
 *   moves onto this same 3.0 `security` row rather than the identically-named but unrelated
 *   `sites.config.uploads`.
 *
 * A 2.x key absent from `rows` altogether is never synthesized: an absent key means an absent
 * field/section in the returned patch, so the downstream `toMerged` leaves 3.0's own default alone
 * rather than overwriting it with an empty string.
 */

/**
 * One row as read from a 2.5.x install's `settings` table. `value` is exactly what a raw row carries:
 * 2.x wraps every non-plain-object value as `{ v: <value> }` and stores plain objects (`mail`,
 * `theming`, `lang`, `seo`, `security`, `uploads`, ...) unwrapped — `./shared.ts`'s
 * `unwrapKnexValue()` undoes that.
 */
export interface SiteSettingsSourceRow extends SourceRecord {
  key: string
  value: unknown
}

export interface SiteSettingsMapping {
  siteConfigPatch: Record<string, any>
  /** A key is present only when the source supplied at least one field for that row — never `{}`,
   * which would merge over nothing but still read as "this source configured it". */
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

/** 2.x `security.*` field name -> 3.0 `settings.security.*` field name. The two polarity-inverted
 * booleans are handled separately: a rename table has nowhere to express "and negate it". */
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

/** 2.x `uploads.*` field name -> 3.0 `settings.security.*` field name: these move tables, not just
 * names. 2.x's `maxFiles` is absent here deliberately — 3.0 has no `uploadMaxFiles` to map it onto.
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
