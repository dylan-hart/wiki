/* global CARDINAL */
import fs from 'node:fs'
import { Client } from 'ldapts'
import type { Entry, SearchOptions, SearchResult } from 'ldapts'
import { ProvisionableLoginError, providerNameHalves } from '../../../models/authentication.ts'

/** Narrow on purpose: a test double needs no more of `Client` than this. */
type LdapClientFactory = (options: { url: string; tlsOptions: Record<string, any> }) => Client

/** ldapts hands back a bare value for a single-value attribute and an array for a multi-value one. */
function attributesOf(entry: Entry): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn') {
      continue
    }
    const values = Array.isArray(value) ? value : [value]
    result[key] = values.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v))
  }
  return result
}

/**
 * RFC 4515 §3 escaping. Both interpolated values — the typed username and a group DN read back from
 * the directory — are attacker- or directory-controlled, so either one unescaped is filter
 * injection: a username of `*)(uid=*` widens `(uid={{username}})` into matching every entry.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\5c'
      case '*':
        return '\\2a'
      case '(':
        return '\\28'
      case ')':
        return '\\29'
      default:
        return '\\00'
    }
  })
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? '')
}

/**
 * OpenSSL verify-error codes Node's `tls` reports for a certificate that fails to chain to a trusted
 * CA. `ldapts` neither normalizes nor wraps them: they arrive exactly as `tls` produced them, on the
 * socket error that failed the pending bind.
 */
const CERT_TRUST_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

/**
 * An administrative bind that fails on an untrusted certificate is a server (or `tlsCertPath`)
 * misconfiguration the person signing in can do nothing about, not "not authorized to login" — hence
 * telling it apart from a genuine bind rejection (upstream issue #1232 / discussion #6891).
 * `ldapts`'s `InvalidCredentialsError` carries none of these codes, so a real credential failure is
 * never misclassified.
 */
function isCertificateTrustError(err: any): boolean {
  if (typeof err?.code === 'string' && CERT_TRUST_ERROR_CODES.has(err.code)) {
    return true
  }
  return (
    typeof err?.message === 'string' &&
    /certificate/i.test(err.message) &&
    /(self.signed|unable to (verify|get)|not trusted|has expired|altname)/i.test(err.message)
  )
}

async function unbindQuietly(client: Client): Promise<void> {
  try {
    await client.unbind()
  } catch {
    // An already-broken connection has nothing useful to report.
  }
}

/**
 * A form-based module (`useForm: true`): the wiki collects username/password itself and verifies
 * them here rather than redirecting to a provider. Verification is search-then-bind, never
 * bind-then-trust — binding straight in as whatever DN the typed username spells would make the
 * check depend on how permissive the server is about unauthenticated or anonymous binds, so the
 * account's real DN is found by an administrative search first and only that DN is bound with the
 * supplied password.
 *
 * `authenticate()` resolves no local user: once LDAP has verified the person it always throws
 * `ProvisionableLoginError`, leaving find-or-create — and, under `mapGroups`, the group re-sync — to
 * `models/users.ts`'s shared auto-provisioning path.
 *
 * Every login failure — a zero- or multi-entry search, a wrong password, a search that errors
 * outright — comes back as the same `ERR_LOGIN_FAILED`: telling them apart from the outside is an
 * account-enumeration oracle. The *administrative* bind stays outside that oracle, neither of its
 * failures being a login mistake: `ERR_STRATEGY_MISCONFIGURED`, or `ERR_LDAP_CERTIFICATE_NOT_TRUSTED`
 * when the directory's certificate does not chain to a trusted CA.
 */
export default class LdapAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  private readonly createLdapClient: LdapClientFactory
  private tlsOptionsCache: Record<string, any> | null = null

  /** `createLdapClient` is overridable only so a test can hand in a double. */
  constructor(
    strategyId: string,
    conf: Record<string, any>,
    createLdapClient: LdapClientFactory = (options) => new Client(options)
  ) {
    this.strategyId = strategyId
    this.conf = conf
    this.createLdapClient = createLdapClient
  }

  async authenticate({ username, password }: { username: string; password: string }): Promise<any> {
    const { url, bindDn, bindCredentials, searchBase, searchFilter } = this.conf
    if (!url || !bindDn || !bindCredentials || !searchBase || !searchFilter) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    // -> `ldapts`'s BindRequest defaults a missing password to `''` and sends it as a simple-auth
    //    bind, which RFC 4513 defines as an unauthenticated bind that many directories (Active
    //    Directory by default) answer with success against any DN that resolves — so an empty
    //    password is refused before the verification bind is ever attempted.
    if (!password) {
      CARDINAL.models.flags.authDebug(
        `LDAP strategy ${this.strategyId}: refused an empty/missing password for "${username}"`
      )
      throw new Error('ERR_LOGIN_FAILED')
    }

    let tlsOptions: Record<string, any>
    try {
      tlsOptions = this.getTlsOptions()
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'could not read the LDAP strategy TLS certificate', {
        module: 'ldap',
        strategy: this.strategyId,
        error: err
      })
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }

    const adminClient = this.createLdapClient({ url, tlsOptions })

    try {
      try {
        await adminClient.bind(bindDn, bindCredentials)
      } catch (err: any) {
        if (isCertificateTrustError(err)) {
          CARDINAL.models.flags.authDebug(
            `LDAP strategy ${this.strategyId}: TLS certificate not trusted: ${err.message}`
          )
          throw new Error('ERR_LDAP_CERTIFICATE_NOT_TRUSTED')
        }
        CARDINAL.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: admin bind failed: ${err.message}`
        )
        throw new Error('ERR_STRATEGY_MISCONFIGURED')
      }

      let result: SearchResult
      try {
        result = await adminClient.search(searchBase, {
          scope: 'sub',
          filter: interpolate(searchFilter, { username: escapeFilterValue(username) })
        })
      } catch (err: any) {
        CARDINAL.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: user search failed: ${err.message}`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }

      const entries = result.searchEntries
      if (entries.length !== 1) {
        CARDINAL.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: search for "${username}" returned ${entries.length} entries`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }
      const entry = entries[0]
      const dn = entry.dn
      if (!dn) {
        throw new Error('ERR_LOGIN_FAILED')
      }

      // -> Its own connection rather than the admin one, so a failed verification bind never
      //    disturbs the connection the optional group search below still needs.
      const userClient = this.createLdapClient({ url, tlsOptions })
      try {
        await userClient.bind(dn, password)
      } catch {
        CARDINAL.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: verification bind for "${username}" failed`
        )
        throw new Error('ERR_LOGIN_FAILED')
      } finally {
        await unbindQuietly(userClient)
      }

      const attrs = attributesOf(entry)
      const id = attrs[this.conf.mappingUID]?.[0]
      const email = attrs[this.conf.mappingEmail]?.[0]
      const name = attrs[this.conf.mappingDisplayName]?.[0]
      /*
        `givenName` and `sn` are read from their RFC 4519 names rather than through mapping props of
        their own: unlike the unique-ID and email attributes -- which really do differ between
        directories, `uid` versus `sAMAccountName` -- every `person` entry uses these two. A
        directory may still hand back an entry with no `sn` value, so a missing surname is a
        supported answer, not an error: nothing is derived from `givenName` to fill it in.
      */
      const [firstName, lastName] = [attrs.givenName?.[0], attrs.sn?.[0]]
      // -> Absent rather than '' when unmapped or unset: "didn't say" must not become a fabricated
      //    default.
      const picture = this.conf.mappingPicture ? attrs[this.conf.mappingPicture]?.[0] : undefined
      if (!id || !email) {
        CARDINAL.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: entry for "${username}" has no value for its unique ID or email mapping`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }

      const groups = this.conf.mapGroups
        ? await this.fetchGroups(adminClient, dn, attrs)
        : undefined

      throw new ProvisionableLoginError({
        id,
        email,
        name: name || email,
        ...providerNameHalves(firstName, lastName),
        groups,
        picture
      })
    } finally {
      await unbindQuietly(adminClient)
    }
  }

  /**
   * `{{dn}}` is interpolated from `groupDnProperty`: "dn" (the default, and not a real attribute
   * ldapts would ever return) means the user entry's own distinguished name; anything else names an
   * attribute read off the user entry already fetched, e.g. a `memberOf`-style value.
   *
   * `undefined` and `[]` are different answers on `ProviderProfile.groups`'s contract: `undefined`
   * means "did not look" and leaves wiki-side membership untouched, `[]` means "looked, found
   * nothing" and revokes every mappable group. A search that fails transiently — after the password
   * bind has already verified the person — did not look, so it answers `undefined`; a misconfigured
   * strategy is not transient and fails the strategy instead.
   */
  private async fetchGroups(
    client: Client,
    dn: string,
    attrs: Record<string, string[]>
  ): Promise<string[] | undefined> {
    const {
      groupSearchBase,
      groupSearchFilter,
      groupSearchScope,
      groupDnProperty,
      groupNameField
    } = this.conf
    if (!groupSearchBase || !groupSearchFilter || !groupNameField) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    const dnValue = groupDnProperty && groupDnProperty !== 'dn' ? attrs[groupDnProperty]?.[0] : dn
    if (!dnValue) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    try {
      const { searchEntries } = await client.search(groupSearchBase, {
        scope: (groupSearchScope as SearchOptions['scope']) || 'sub',
        filter: interpolate(groupSearchFilter, { dn: escapeFilterValue(dnValue) })
      })
      return searchEntries
        .map((groupEntry) => attributesOf(groupEntry)[groupNameField]?.[0])
        .filter((name): name is string => Boolean(name))
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'group search failed, leaving group membership unchanged', {
        module: 'ldap',
        strategy: this.strategyId,
        error: err
      })
      return undefined
    }
  }

  /**
   * No cert path means "trust the system CA store (or don't verify at all)". A configured path is
   * read from disk only when verification is actually on, since an unused one may not be readable.
   */
  private getTlsOptions(): Record<string, any> {
    if (this.tlsOptionsCache) {
      return this.tlsOptionsCache
    }
    if (!this.conf.tlsEnabled) {
      this.tlsOptionsCache = {}
      return this.tlsOptionsCache
    }
    if (!this.conf.tlsCertPath) {
      this.tlsOptionsCache = { rejectUnauthorized: this.conf.verifyTLSCertificate }
      return this.tlsOptionsCache
    }
    const ca = this.conf.verifyTLSCertificate ? [fs.readFileSync(this.conf.tlsCertPath)] : []
    this.tlsOptionsCache = { rejectUnauthorized: this.conf.verifyTLSCertificate, ca }
    return this.tlsOptionsCache
  }
}
