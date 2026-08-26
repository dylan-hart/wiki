import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { toMerged } from 'es-toolkit/object'
import { mapSiteSettings, type SiteSettingsSourceRow } from './site-settings.ts'

/**
 * `mapSiteSettings` scope (task 764): only the fields the task description names —
 * title/description/company/contentLicense/logoUrl/theme(dark/tocPosition/injectCSS/injectHead/
 * injectBody)/locales.primary on the `sites.config` side, and `mail` + `security` (folding in 2.x's
 * `uploads.*`) on the instance-wide `settings` side. Every other 2.x key documented in
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md` is out of scope for this mapper
 * (either NO DESTINATION, or owned by a sibling task — auth strategies by 765, storage by 767).
 */

describe('mapSiteSettings', () => {
  test('an empty source produces an empty patch — everything falls through to 3.0 defaults', () => {
    const result = mapSiteSettings([])
    assert.deepEqual(result.siteConfigPatch, {})
    assert.deepEqual(result.instanceSettings, {})
  })

  test('unwraps 2.x scalar rows stored as { v: ... } (configSvc.saveToDb wrapping)', () => {
    const rows: SiteSettingsSourceRow[] = [
      { key: 'title', value: { v: 'Acme Wiki' } },
      { key: 'company', value: { v: 'Acme Corp' } },
      { key: 'contentLicense', value: { v: 'CC-BY-SA' } },
      { key: 'logoUrl', value: { v: '/logo.png' } }
    ]
    const { siteConfigPatch } = mapSiteSettings(rows)
    assert.deepEqual(siteConfigPatch, {
      title: 'Acme Wiki',
      company: 'Acme Corp',
      contentLicense: 'CC-BY-SA',
      logoUrl: '/logo.png'
    })
  })

  test('maps seo.description, dropping the out-of-scope seo.robots/analytics fields', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'seo',
        value: {
          description: 'A wiki about things',
          robots: ['index', 'follow'],
          analyticsService: '',
          analyticsId: ''
        }
      }
    ]
    const { siteConfigPatch } = mapSiteSettings(rows)
    assert.deepEqual(siteConfigPatch, { description: 'A wiki about things' })
  })

  test('maps only the theming sub-fields with a 3.0 destination, renaming darkMode to dark', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'theming',
        value: {
          theme: 'default',
          iconset: 'mdi',
          darkMode: true,
          tocPosition: 'left',
          injectCSS: '.a { color: red; }',
          injectHead: '<meta>',
          injectBody: '<script></script>'
        }
      }
    ]
    const { siteConfigPatch } = mapSiteSettings(rows)
    assert.deepEqual(siteConfigPatch.theme, {
      dark: true,
      tocPosition: 'left',
      injectCSS: '.a { color: red; }',
      injectHead: '<meta>',
      injectBody: '<script></script>'
    })
  })

  test('a partial theming row only patches the sub-fields it actually has', () => {
    const rows: SiteSettingsSourceRow[] = [{ key: 'theming', value: { injectCSS: '.only {}' } }]
    const { siteConfigPatch } = mapSiteSettings(rows)
    assert.deepEqual(siteConfigPatch.theme, { injectCSS: '.only {}' })
  })

  test('maps lang.code to locales.primary, dropping the out-of-scope lang sub-fields', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'lang',
        value: { code: 'fr', autoUpdate: true, namespaces: [], namespacing: false, rtl: false }
      }
    ]
    const { siteConfigPatch } = mapSiteSettings(rows)
    assert.deepEqual(siteConfigPatch.locales, { primary: 'fr' })
  })

  test('a source with no mail row at all leaves instanceSettings.mail unset (falls through)', () => {
    const rows: SiteSettingsSourceRow[] = [{ key: 'title', value: { v: 'Acme Wiki' } }]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.equal('mail' in instanceSettings, false)
  })

  test('an install-time-default (never configured) mail row is still copied verbatim, field-by-field', () => {
    // The exact shape server/setup.js inserts at install time, before an admin ever visits the mail
    // settings screen — every field present, all still at their blank/default value.
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'mail',
        value: {
          senderName: '',
          senderEmail: '',
          host: '',
          port: 465,
          name: '',
          secure: true,
          verifySSL: true,
          user: '',
          pass: '',
          useDKIM: false,
          dkimDomainName: '',
          dkimKeySelector: '',
          dkimPrivateKey: ''
        }
      }
    ]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.deepEqual(instanceSettings.mail, {
      senderName: '',
      senderEmail: '',
      host: '',
      port: 465,
      name: '',
      secure: true,
      verifySSL: true,
      user: '',
      pass: '',
      useDKIM: false,
      dkimDomainName: '',
      dkimKeySelector: '',
      dkimPrivateKey: ''
    })
    // `defaultBaseURL` is new in 3.0 with no 2.x source — must never appear in the patch, so
    // toMerged(defaults, patch) leaves 3.0's own default value in place.
    assert.equal('defaultBaseURL' in instanceSettings.mail!, false)
  })

  test('a configured mail row copies every field verbatim, including the password', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'mail',
        value: {
          senderName: 'Acme Wiki',
          senderEmail: 'wiki@acme.test',
          host: 'smtp.acme.test',
          port: 587,
          name: 'smtp.acme.test',
          secure: false,
          verifySSL: true,
          user: 'wiki@acme.test',
          pass: 'super-secret',
          useDKIM: false,
          dkimDomainName: '',
          dkimKeySelector: '',
          dkimPrivateKey: ''
        }
      }
    ]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.equal(instanceSettings.mail?.pass, 'super-secret')
    assert.equal(instanceSettings.mail?.host, 'smtp.acme.test')
  })

  test('security: renames fields and inverts the securityOpenRedirect/securityIframe polarity', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'security',
        value: {
          securityOpenRedirect: true, // 2.x true = allowed -> 3.0 disallowOpenRedirect must be false
          securityIframe: false, // 2.x false = allowed -> 3.0 disallowIframe must be true
          securityReferrerPolicy: true,
          securityTrustProxy: false,
          securitySRI: true, // NO DESTINATION — must be dropped
          securityHSTS: true,
          securityHSTSDuration: 31536000,
          securityCSP: false,
          securityCSPDirectives: "default-src 'self'"
        }
      }
    ]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.deepEqual(instanceSettings.security, {
      disallowOpenRedirect: false,
      disallowIframe: true,
      enforceSameOriginReferrerPolicy: true,
      trustProxy: false,
      enforceHsts: true,
      hstsDuration: 31536000,
      enforceCsp: false,
      cspDirectives: "default-src 'self'"
    })
  })

  test('uploads.* folds into the same instance-wide security patch, renamed, per the field-mapping doc', () => {
    const rows: SiteSettingsSourceRow[] = [
      {
        key: 'uploads',
        value: { maxFileSize: 5242880, scanSVG: false, forceDownload: false }
      }
    ]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.deepEqual(instanceSettings.security, {
      uploadMaxFileSize: 5242880,
      uploadScanSVG: false,
      forceAssetDownload: false
    })
  })

  test('security and uploads rows both present merge into one security patch', () => {
    const rows: SiteSettingsSourceRow[] = [
      { key: 'security', value: { securityTrustProxy: true } },
      { key: 'uploads', value: { maxFileSize: 3 } }
    ]
    const { instanceSettings } = mapSiteSettings(rows)
    assert.deepEqual(instanceSettings.security, { trustProxy: true, uploadMaxFileSize: 3 })
  })

  test('neither security nor uploads present leaves instanceSettings.security unset', () => {
    const { instanceSettings } = mapSiteSettings([{ key: 'title', value: { v: 'x' } }])
    assert.equal('security' in instanceSettings, false)
  })

  test(
    'the resulting patches genuinely deep-merge onto stand-in 3.0 defaults via toMerged, ' +
      'leaving untouched sibling fields alone',
    () => {
      const siteDefaults = {
        title: 'My Wiki Site',
        company: '',
        theme: {
          dark: false,
          colorPrimary: '#1976D2',
          tocPosition: 'right',
          injectCSS: ''
        },
        locales: { primary: 'en', active: ['en'], forcePrefix: false, showMenu: true }
      }
      const mailDefaults = {
        senderName: '',
        host: '',
        port: 465,
        defaultBaseURL: 'https://wiki.example.com'
      }

      const rows: SiteSettingsSourceRow[] = [
        { key: 'title', value: { v: 'Acme Wiki' } },
        { key: 'theming', value: { injectCSS: '.a{}' } },
        { key: 'mail', value: { host: 'smtp.acme.test', port: 465 } }
      ]
      const { siteConfigPatch, instanceSettings } = mapSiteSettings(rows)

      const mergedSite = toMerged(siteDefaults, siteConfigPatch)
      assert.equal(mergedSite.title, 'Acme Wiki')
      assert.equal(mergedSite.company, '') // untouched sibling field
      assert.equal(mergedSite.theme.injectCSS, '.a{}')
      assert.equal(mergedSite.theme.colorPrimary, '#1976D2') // untouched sibling theme field
      assert.equal(mergedSite.theme.dark, false) // untouched sibling theme field
      assert.deepEqual(mergedSite.locales, {
        primary: 'en',
        active: ['en'],
        forcePrefix: false,
        showMenu: true
      })

      const mergedMail = toMerged(mailDefaults, instanceSettings.mail ?? {})
      assert.equal(mergedMail.host, 'smtp.acme.test')
      assert.equal(mergedMail.defaultBaseURL, 'https://wiki.example.com') // untouched, no 2.x source
    }
  )
})
