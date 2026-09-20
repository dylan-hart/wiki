import { settings as settingsTable } from '../db/schema.ts'
import { generateSigningCertificates } from './apiKeys.ts'
import { DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './auditLog.ts'
import crypto from 'node:crypto'
import type { SystemIds } from './types.ts'

/**
 * Alone among the fields `Settings#init` seeds, these two come from
 * `CARDINAL.config`/`CARDINAL.data` (`base.yml` merged with any `config.yml` override, since
 * `configSvc.init()` runs first) rather than hardcoded: the indirection exists solely so
 * `e2e/config.e2e.yml` can seed `enforceCsp: true` for the CSP spec without touching what a real
 * fresh install ships with.
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

class Settings {
  /** `false` means the table is empty, not that the read failed. */
  async getConfig(): Promise<Record<string, any> | false> {
    const settings = await CARDINAL.db.select().from(settingsTable)
    if (settings.length > 0) {
      return settings.reduce((res: Record<string, any>, val: any) => {
        res[val.key] = 'v' in val.value ? val.value.v : val.value
        return res
      }, {})
    } else {
      return false
    }
  }

  async updateConfig(key: string, value: Record<string, any>): Promise<void> {
    await CARDINAL.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
  }

  async init(ids: SystemIds): Promise<void> {
    CARDINAL.logger.debug('config', 'generating the signing certificates')
    const certs = generateSigningCertificates()

    CARDINAL.logger.debug('config', 'seeding the default settings')
    await CARDINAL.db.insert(settingsTable).values([
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
          // -> What @fastify/session signs its cookies with, exclusively. Kept separate from the
          //    keypair's passphrase so either can be rotated without disturbing the other.
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
          defaultBaseURL: '',
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
          // -> Keys `hashVisitor()`'s HMAC (`models/pageviews.ts`). Deliberately its own value
          //    rather than `auth.secret` reused: the two protect different things, and sharing one
          //    would make rotating either break the other.
          hashKey: crypto.randomBytes(32).toString('hex')
        }
      },
      {
        key: 'security',
        value: {
          corsConfig: '',
          corsMode: 'OFF',
          ...securityCspSeed(CARDINAL.config, CARDINAL.data),
          disallowIframe: true,
          disallowOpenRedirect: true,
          enforceHsts: false,
          enforceSameOriginReferrerPolicy: true,
          forceAssetDownload: true,
          hstsDuration: 0,
          trustProxy: false,
          uploadMaxFileSize: 10485760,
          uploadMaxFilesPerBatch: 10,
          uploadScanSVG: true
        }
      },
      {
        key: 'update',
        value: {
          lastCheckedAt: null,
          version: CARDINAL.version,
          versionDate: CARDINAL.releaseDate
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
