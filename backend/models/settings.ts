import { settings as settingsTable } from '../db/schema.ts'
import { generateSigningCertificates } from './apiKeys.ts'
import { DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './auditLog.ts'
import crypto from 'node:crypto'
import type { SystemIds } from './types.ts'

/**
 * The `security.cspDirectives`/`security.enforceCsp` values `Settings#init` seeds a fresh
 * instance's DB row with (WP #2158/#2166, part of #2154).
 *
 * Pulled from `config`/`data` -- `WIKI.config`/`WIKI.data` at call time, i.e. `base.yml` already
 * merged with any `config.yml` override, since `configSvc.init()` runs before `initDbValues()`
 * ever does -- rather than hardcoded like every other field `Settings#init` seeds. Everywhere but a
 * test config this resolves to exactly `base.yml`'s own default (`enforceCsp: false`, the literal
 * `cspDirectives` string documented and tested there): the indirection exists solely so
 * `e2e/config.e2e.yml` can seed `enforceCsp: true` for `e2e/tests/csp.spec.js` without ever
 * touching what a real fresh install ships with. Exported and factored out of the literal `init()`
 * once inserted here so it is a plain function to unit-test, rather than only reachable through a
 * DB-backed `Settings#init` round trip.
 *
 * @param config `WIKI.config` -- `base.yml` merged with any `config.yml` override.
 * @param data `WIKI.data` -- `base.yml`'s own parsed defaults, consulted only as the fallback for
 * the case nothing upstream set either key at all.
 */
export function securityCspSeed(
  config: { security?: { cspDirectives?: string; enforceCsp?: boolean } } | undefined,
  data: { defaults?: { config?: { security?: { cspDirectives?: string } } } } | undefined
): { cspDirectives: string; enforceCsp: boolean } {
  return {
    cspDirectives:
      config?.security?.cspDirectives ?? data?.defaults?.config?.security?.cspDirectives ?? '',
    enforceCsp: config?.security?.enforceCsp ?? false
  }
}

/**
 * Settings model
 */
class Settings {
  /**
   * Fetch settings from DB
   * @returns Settings, or `false` when the table is empty
   */
  async getConfig(): Promise<Record<string, any> | false> {
    const settings = await WIKI.db.select().from(settingsTable)
    if (settings.length > 0) {
      return settings.reduce((res: Record<string, any>, val: any) => {
        res[val.key] = 'v' in val.value ? val.value.v : val.value
        return res
      }, {})
    } else {
      return false
    }
  }

  /**
   * Apply settings to DB
   * @param key Setting key
   * @param value Setting value object
   */
  async updateConfig(key: string, value: Record<string, any>): Promise<void> {
    await WIKI.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
  }

  /**
   * Initialize settings table
   * @param ids Generated IDs
   */
  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.debug('config', 'generating the signing certificates')
    const certs = generateSigningCertificates()

    WIKI.logger.debug('config', 'seeding the default settings')
    await WIKI.db.insert(settingsTable).values([
      {
        key: 'api',
        value: {
          isEnabled: false
        }
      },
      {
        key: 'auditLog',
        value: {
          retentionDays: DEFAULT_AUDIT_LOG_RETENTION_DAYS
        }
      },
      {
        key: 'auth',
        value: {
          // -> The installation keypair, carrying its own passphrase. Its one job is signing API
          //    keys (`models/apiKeys.ts`).
          certs,
          // -> What @fastify/session signs its cookies with, and nothing else. Separate from the
          //    keypair's passphrase so that either can be rotated without disturbing the other —
          //    the two utilities that do so are `POST /system/certificates` and
          //    `POST /system/sessions/invalidate`.
          secret: crypto.randomBytes(32).toString('hex'),
          rootAdminGroupId: ids.groupAdminId,
          rootAdminUserId: ids.userAdminId,
          guestUserId: ids.userGuestId
        }
      },
      {
        key: 'flags',
        value: {
          experimental: false,
          authDebug: false,
          sqlLog: false
        }
      },
      {
        key: 'mail',
        value: {
          senderName: '',
          senderEmail: '',
          defaultBaseURL: 'https://wiki.example.com',
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
      },
      {
        key: 'metrics',
        value: {
          isEnabled: false
        }
      },
      {
        key: 'pageviews',
        value: {
          isEnabled: true,
          // -> Keys `hashVisitor()`'s HMAC (`models/pageviews.ts`) -- generated fresh here, same as
          //    `auth.secret` above, and deliberately its own independent value rather than reused
          //    from it: the two protect different things (session cookies vs. pageview
          //    pseudonymisation), and sharing one would mean rotating either also breaks the other.
          hashKey: crypto.randomBytes(32).toString('hex')
        }
      },
      {
        key: 'security',
        value: {
          corsConfig: '',
          corsMode: 'OFF',
          // -> See `securityCspSeed`'s own doc comment above for why these two fields, alone in
          //    this block, are not hardcoded literals.
          ...securityCspSeed(WIKI.config, WIKI.data),
          disallowIframe: true,
          disallowOpenRedirect: true,
          enforceHsts: false,
          enforceSameOriginReferrerPolicy: true,
          forceAssetDownload: true,
          hstsDuration: 0,
          trustProxy: false,
          uploadMaxFileSize: 10485760,
          uploadScanSVG: true
        }
      },
      {
        key: 'update',
        value: {
          lastCheckedAt: null,
          version: WIKI.version,
          versionDate: WIKI.releaseDate
        }
      },
      {
        key: 'userDefaults',
        value: {
          timezone: 'America/New_York',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '12h'
        }
      }
    ])
  }
}

export const settings = new Settings()
