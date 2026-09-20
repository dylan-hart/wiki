import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { mapSiteSettings, type SiteSettingsSourceRow } from './site-settings.ts'
import { mapAuthenticationRows, type SourceAuthenticationRow } from './authentication.ts'
import { mapStorageRow, type SourceStorageRow } from './storage.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Drives all three mappers off standalone JSON fixtures under `./fixtures/`, each shaped like a real
 * 2.5.x table dump — the `{ v: <value> }` wrapper a raw-Postgres row carries on `settings.value` and
 * on `authentication.domainWhitelist`/`autoEnrollGroups` included. Each is asserted against the
 * *exact* resulting 3.0 shape rather than spot-checked fields, so any change to a mapper's output
 * shape surfaces here even where the narrower per-mapper suites do not reach.
 *
 * The two authentication source fixtures are mapped as two independent runs: an import consolidates
 * exactly one 2.5.x source into one fresh 3.0 instance, so there is no cross-source conflict policy
 * to exercise.
 */

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures')

async function loadFixture<T>(name: string): Promise<T> {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, name), 'utf8')
  return JSON.parse(raw) as T
}

let wikiHandle: { restore(): void }

before(async () => {
  await ensureTemporal()
  wikiHandle = installTestWiki({ SERVERPATH: path.join(import.meta.dirname, '..', '..') })
  const { authentication } = await import('../../models/authentication.ts')
  await authentication.refreshStrategiesFromDisk()
  const { storage } = await import('../../models/storage.ts')
  await storage.refreshFromDisk()
  assert.ok(CARDINAL.data.authentication?.length > 0)
  assert.ok(storage.definitions.length > 0)
})

after(() => {
  wikiHandle.restore()
})

describe('fixture: 2.5x-settings.json -> mapSiteSettings', () => {
  test('produces the exact sites.config patch and instance-wide settings patches', async () => {
    const rows = await loadFixture<SiteSettingsSourceRow[]>('2.5x-settings.json')
    const result = mapSiteSettings(rows)

    assert.deepEqual(result.siteConfigPatch, {
      title: 'Corporate Knowledge Base',
      company: 'Acme Corp',
      contentLicense: 'CC-BY-SA-4.0',
      logoUrl: '/uploads/logo.png',
      description: "Acme Corp's internal knowledge base.",
      theme: {
        tocPosition: 'left',
        injectCSS: '',
        injectHead: '',
        injectBody: '',
        dark: true
      },
      locales: { primary: 'en' }
    })

    assert.deepEqual(result.instanceSettings, {
      mail: {
        senderName: 'Acme Wiki',
        senderEmail: 'wiki@acme.example.com',
        host: 'smtp.acme.example.com',
        port: 587,
        name: '',
        secure: true,
        verifySSL: true,
        user: 'smtp-user',
        pass: 'smtp-pass',
        useDKIM: false,
        dkimDomainName: '',
        dkimKeySelector: '',
        dkimPrivateKey: ''
      },
      security: {
        enforceSameOriginReferrerPolicy: true,
        trustProxy: false,
        enforceHsts: false,
        hstsDuration: 15552000,
        enforceCsp: false,
        cspDirectives: '',
        // renamed AND polarity-inverted: the source has both flags `true`
        disallowOpenRedirect: false,
        disallowIframe: false,
        // 2.x `uploads.*` moves here; the fixture's `uploads.maxFiles` has no 3.0 destination and is
        // dropped rather than mapped.
        uploadMaxFileSize: 200,
        uploadScanSVG: true,
        forceAssetDownload: false
      }
    })
  })
})

describe('fixture: 2.5x-authentication-source-{a,b}.json -> mapAuthenticationRows', () => {
  async function resolver() {
    return (await import('../../models/authentication.ts')).authentication
  }

  test('domainWhitelist->regex, unsupported firebase, and the per-module config remaps', async () => {
    const sourceA = await loadFixture<SourceAuthenticationRow[]>(
      '2.5x-authentication-source-a.json'
    )
    const sourceB = await loadFixture<SourceAuthenticationRow[]>(
      '2.5x-authentication-source-b.json'
    )
    const res = await resolver()

    const resultA = await mapAuthenticationRows(sourceA, { resolver: res })
    const resultB = await mapAuthenticationRows(sourceB, { resolver: res })

    assert.equal(resultA.results.length, 3)
    assert.equal(resultB.results.length, 2)

    assert.deepEqual(resultA.results[0], {
      sourceKey: 'local',
      module: 'local',
      status: 'created',
      row: {
        module: 'local',
        isEnabled: true,
        displayName: 'Local Database',
        selfRegistration: true,
        autoProvision: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        config: { enforceTfa: false, emailValidation: true, allowForgotPassword: true }
      }
    })

    assert.deepEqual(resultA.results[1], {
      sourceKey: 'github',
      module: 'github',
      status: 'created',
      row: {
        module: 'github',
        isEnabled: true,
        displayName: 'GitHub (Acme)',
        selfRegistration: false,
        autoProvision: false,
        allowedEmailRegex: '^[^@]+@(acme\\.com|acme\\.org)$',
        // -> Always empty: `settings` runs before `users`, so the 2.x integer group ids have nothing
        //    imported yet to remap onto.
        autoEnrollGroups: [],
        config: {
          clientId: 'gh-client-a',
          clientSecret: 'gh-secret-a',
          enterpriseHost: 'github.acme.example.com',
          allowedOrganization: ''
        }
      }
    })

    // -> There is no `backend/modules/authentication/firebase/` directory, so the row is reported
    //    rather than silently dropped, and nothing is written.
    assert.equal(resultA.results[2].status, 'unsupported')
    assert.equal(resultA.results[2].sourceKey, 'firebase')
    assert.equal(resultA.results[2].module, 'firebase')
    assert.equal(resultA.results[2].row, undefined)
    assert.match(resultA.results[2].message!, /firebase/)

    assert.deepEqual(resultB.results[0], {
      sourceKey: 'local',
      module: 'local',
      status: 'created',
      row: {
        module: 'local',
        isEnabled: true,
        displayName: 'Local Database',
        selfRegistration: false,
        autoProvision: false,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        config: { enforceTfa: false, emailValidation: true, allowForgotPassword: true }
      }
    })

    assert.deepEqual(resultB.results[1], {
      sourceKey: 'oidc-beta',
      module: 'oidc',
      status: 'created',
      row: {
        module: 'oidc',
        isEnabled: true,
        displayName: 'Beta SSO',
        selfRegistration: true,
        autoProvision: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        config: {
          clientId: 'oidc-client-b',
          clientSecret: 'oidc-secret-b',
          issuer: '',
          useDiscovery: true,
          authorizationURL: 'https://idp.beta.example.com/authorize',
          tokenURL: 'https://idp.beta.example.com/token',
          userInfoURL: 'https://idp.beta.example.com/userinfo',
          jwksURL: '',
          scopes: 'openid profile email',
          emailClaim: 'email',
          allowUnverifiedEmail: false,
          displayNameClaim: 'name',
          // -> Every prop the 2.x source row does not carry lands at its `definition.yml` default,
          //    so an imported strategy is shaped like a freshly-created one.
          firstNameClaim: 'given_name',
          lastNameClaim: 'family_name',
          pictureClaim: 'picture',
          logoutURL: '',
          mapGroups: false,
          groupsClaim: 'groups',
          groupsScope: ''
        }
      }
    })
  })
})

describe('fixture: 2.5x-storage.json -> mapStorageRow', () => {
  async function resolver() {
    return (await import('../../models/storage.ts')).storage
  }

  const SITE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

  test('disk row: direct prop copy, mode maps straight through (disk only ever supports push), no syncInterval to convert', async () => {
    const rows = await loadFixture<SourceStorageRow[]>('2.5x-storage.json')
    const disk = rows.find((r) => r.key === 'disk')!
    const result = mapStorageRow(disk, { resolver: await resolver(), siteId: SITE_ID })

    assert.deepEqual(result, {
      sourceKey: 'disk',
      module: 'disk',
      siteId: SITE_ID,
      status: 'updated',
      update: {
        siteId: SITE_ID,
        module: 'disk',
        values: {
          isEnabled: true,
          config: { path: '/var/wiki/data', createDailyBackups: true },
          syncMode: 'push'
        }
      }
    })
  })

  test('git row: sshPrivateKeyMode "contents"->"inline" enum rename, alwaysNamespace dropped (confirmed NO DESTINATION), mode/syncInterval both convert', async () => {
    const rows = await loadFixture<SourceStorageRow[]>('2.5x-storage.json')
    const git = rows.find((r) => r.key === 'git')!
    const result = mapStorageRow(git, { resolver: await resolver(), siteId: SITE_ID })

    assert.equal(result.status, 'updated')
    assert.deepEqual(result.update!.values.config, {
      authType: 'ssh',
      repoUrl: 'git@git.acme.example.com:acme/wiki-content.git',
      branch: 'main',
      sshPrivateKeyMode: 'inline',
      sshPrivateKeyPath: '',
      sshPrivateKeyContent:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYDATA\n-----END OPENSSH PRIVATE KEY-----',
      verifySSL: true,
      basicUsername: '',
      basicPassword: '',
      defaultEmail: 'wiki-bot@acme.example.com',
      defaultName: 'Wiki Bot',
      localRepoPath: './data/repo',
      maxDeletePercent: 50,
      gitBinaryPath: ''
    })
    // -> 'sync' is one of git's own supportedModes and the fixture's cron syncInterval is a
    //    convertible shape, so both map through and nothing is reported as dropped.
    assert.equal(result.update!.values.syncMode, 'sync')
    assert.equal(result.update!.values.scheduleOverride, 'PT15M')
    assert.equal(result.droppedFields, undefined)
    // alwaysNamespace never reached buildConfig at all — not merely defaulted away.
    assert.ok(!('alwaysNamespace' in result.update!.values.config))
  })

  test('dropbox row: the storage no-destination-yet path this task names — no modules/storage/dropbox directory, reported as unsupported, no update written', async () => {
    const rows = await loadFixture<SourceStorageRow[]>('2.5x-storage.json')
    const dropbox = rows.find((r) => r.key === 'dropbox')!
    const result = mapStorageRow(dropbox, { resolver: await resolver(), siteId: SITE_ID })

    assert.equal(result.status, 'unsupported')
    assert.equal(result.sourceKey, 'dropbox')
    assert.equal(result.module, 'dropbox')
    assert.equal(result.update, undefined)
    assert.equal(result.droppedFields, undefined)
    assert.match(result.message!, /dropbox/)
  })
})
