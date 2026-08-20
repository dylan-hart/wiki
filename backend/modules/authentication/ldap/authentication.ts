/* global WIKI */
import fs from 'node:fs'
import ldap from 'ldapjs'
import type { Client, SearchEntry, SearchOptions } from 'ldapjs'
import { ProvisionableLoginError } from '../../../models/authentication.ts'

/** Only what this module actually calls, kept narrow so a test double needs no more than this. */
type LdapClientFactory = (options: { url: string; tlsOptions: Record<string, any> }) => Client

/** Attribute values as ldapjs hands them back: always an array, even for a single-value attribute. */
function attributesOf(entry: SearchEntry): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const attr of entry.attributes) {
    result[attr.type] = ([] as string[]).concat(attr.values)
  }
  return result
}

/**
 * Escapes a value for safe interpolation into an LDAP search filter (RFC 4515 §3). Both of this
 * module's interpolated values — the typed username, and a group DN read back from the directory —
 * are attacker- or directory-controlled strings dropped straight into a filter, so unescaped either one
 * is an LDAP filter injection (e.g. a username of `*)(uid=*` widening `(uid={{username}})` into
 * matching every entry).
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
 * OpenSSL verify-error codes Node's `tls` module reports for a certificate that fails to chain to a
 * trusted CA — as opposed to any other connection failure. `ldapjs` does not normalize or wrap these;
 * they arrive here exactly as `tls` produced them on the socket error that failed the pending bind.
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
 * True for a TLS handshake failure caused by an untrusted certificate, false for a genuine bind
 * rejection (wrong DN/password) or any other connection error. Distinguishing the two matters: an
 * administrative bind that fails because the directory's certificate is not trusted is not "not
 * authorized to login" — it is a server (or `tlsCertPath`) misconfiguration the person signing in can
 * do nothing about, and previously came back indistinguishable from a bad password (upstream issue
 * #1232 / discussion #6891). `ldapjs`'s own `InvalidCredentialsError` carries none of these codes, so
 * this never misclassifies a real credential failure.
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

function bindAsync(client: Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => (err ? reject(err) : resolve()))
  })
}

function searchAsync(client: Client, base: string, options: SearchOptions): Promise<SearchEntry[]> {
  return new Promise((resolve, reject) => {
    client.search(base, options, (err, res) => {
      if (err) {
        reject(err)
        return
      }
      const entries: SearchEntry[] = []
      res.on('searchEntry', (entry) => entries.push(entry))
      res.on('error', (errSearch) => reject(errSearch))
      res.on('end', () => resolve(entries))
    })
  })
}

/** Best-effort: a connection that is already broken has nothing useful to report on unbind. */
function unbindAsync(client: Client): Promise<void> {
  return new Promise((resolve) => {
    try {
      client.unbind(() => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * LDAP / Active Directory
 *
 * A form-based module (`useForm: true`): the wiki collects username/password itself and verifies them
 * here rather than redirecting to a provider. Verification is search-then-bind, never bind-then-trust —
 * binding straight in as whatever DN the typed username happens to spell would let that check depend on
 * how permissive the server is about unauthenticated or anonymous binds, so the account's real DN is
 * always found by an administrative search first, and only *that* DN is bound with the supplied
 * password to actually check it.
 *
 * `authenticate()` never resolves a local user itself. Like a redirect-based module handing back a
 * `ProviderProfile` for `loginWithProvider()` to resolve, it always throws `ProvisionableLoginError`
 * once LDAP has verified the person, and leaves finding-or-creating the account — and, when `mapGroups`
 * is on, re-syncing group membership — to `models/users.ts`'s shared auto-provisioning path (`login()`
 * and `findOrCreateProviderUser()`). See `ProvisionableLoginError`'s own doc comment.
 *
 * Every failure — a zero- or multi-entry search, a verification bind with the wrong password, a search
 * that errors outright — comes back as the same `ERR_LOGIN_FAILED`, deliberately: telling any of those
 * apart from the outside is an account-enumeration oracle. Two exceptions, neither of which is a login
 * mistake and so neither of which is folded into that oracle: the *administrative* bind
 * (`bindDn`/`bindCredentials`) failing outright means the strategy itself is misconfigured
 * (`ERR_STRATEGY_MISCONFIGURED`), and that same bind failing because the directory's TLS certificate
 * does not chain to a trusted CA — a `tlsCertPath` problem, not a credentials one — is reported as
 * `ERR_LDAP_CERTIFICATE_NOT_TRUSTED` instead (`isCertificateTrustError()`), so an administrator is not
 * sent chasing a bad password that was never the issue (upstream issue #1232 / discussion #6891).
 */
export default class LdapAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  private readonly createLdapClient: LdapClientFactory
  /** Read from disk once and reused — mirrors 2.5.x's `getTlsOptions()`. */
  private tlsOptionsCache: Record<string, any> | null = null

  /**
   * @param createLdapClient Defaults to the real `ldapjs` client. Overridable only so a test can hand
   *   in a double instead of talking to a real directory server.
   */
  constructor(
    strategyId: string,
    conf: Record<string, any>,
    createLdapClient: LdapClientFactory = ldap.createClient as unknown as LdapClientFactory
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

    let tlsOptions: Record<string, any>
    try {
      tlsOptions = this.getTlsOptions()
    } catch (err: any) {
      WIKI.logger.warn(
        `LDAP strategy ${this.strategyId}: could not read its TLS certificate: ${err.message}`
      )
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }

    const adminClient = this.createLdapClient({ url, tlsOptions })
    // -> Without a listener, a connection-level failure (bad host, refused connection) emits 'error'
    //    on the client and crashes the process — the actual failure still surfaces through whichever
    //    pending bind/search callback was queued when the connection died.
    adminClient.on('error', () => {})

    try {
      try {
        await bindAsync(adminClient, bindDn, bindCredentials)
      } catch (err: any) {
        if (isCertificateTrustError(err)) {
          WIKI.models.flags.authDebug(
            `LDAP strategy ${this.strategyId}: TLS certificate not trusted: ${err.message}`
          )
          throw new Error('ERR_LDAP_CERTIFICATE_NOT_TRUSTED')
        }
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: admin bind failed: ${err.message}`
        )
        throw new Error('ERR_STRATEGY_MISCONFIGURED')
      }

      let entries: SearchEntry[]
      try {
        entries = await searchAsync(adminClient, searchBase, {
          scope: 'sub',
          filter: interpolate(searchFilter, { username: escapeFilterValue(username) })
        })
      } catch (err: any) {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: user search failed: ${err.message}`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }

      if (entries.length !== 1) {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: search for "${username}" returned ${entries.length} entries`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }
      const entry = entries[0]
      const dn = entry.objectName
      if (!dn) {
        throw new Error('ERR_LOGIN_FAILED')
      }

      // -> The actual credential check: bind as the DN the search found, with the password supplied.
      //    A separate client/connection than the admin one — this bind's only job is to succeed or
      //    fail, and doing it on its own connection keeps a failed attempt from ever touching the
      //    connection still needed for the optional group search below.
      const userClient = this.createLdapClient({ url, tlsOptions })
      userClient.on('error', () => {})
      try {
        await bindAsync(userClient, dn, password)
      } catch {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: verification bind for "${username}" failed`
        )
        throw new Error('ERR_LOGIN_FAILED')
      } finally {
        await unbindAsync(userClient)
      }

      const attrs = attributesOf(entry)
      const id = attrs[this.conf.mappingUID]?.[0]
      const email = attrs[this.conf.mappingEmail]?.[0]
      const name = attrs[this.conf.mappingDisplayName]?.[0]
      if (!id || !email) {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: entry for "${username}" has no value for its unique ID or email mapping`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }

      const groups = this.conf.mapGroups
        ? await this.fetchGroups(adminClient, dn, attrs)
        : undefined

      throw new ProvisionableLoginError({ id, email, name: name || email, groups })
    } finally {
      await unbindAsync(adminClient)
    }
  }

  /**
   * Directory groups for the user just verified, by name — matched against wiki groups of the same
   * name by `models/users.ts`'s `syncProviderGroups()`, not here.
   *
   * `{{dn}}` is interpolated from `groupDnProperty`: "dn" (the default, and not a real attribute
   * ldapjs would ever return) means the user entry's own distinguished name; anything else names an
   * attribute read off the user entry already fetched, e.g. a `memberOf`-style value.
   */
  private async fetchGroups(
    client: Client,
    dn: string,
    attrs: Record<string, string[]>
  ): Promise<string[]> {
    const {
      groupSearchBase,
      groupSearchFilter,
      groupSearchScope,
      groupDnProperty,
      groupNameField
    } = this.conf
    if (!groupSearchBase || !groupSearchFilter || !groupNameField) {
      return []
    }
    const dnValue = groupDnProperty && groupDnProperty !== 'dn' ? attrs[groupDnProperty]?.[0] : dn
    if (!dnValue) {
      return []
    }
    try {
      const entries = await searchAsync(client, groupSearchBase, {
        scope: (groupSearchScope as SearchOptions['scope']) || 'sub',
        filter: interpolate(groupSearchFilter, { dn: escapeFilterValue(dnValue) })
      })
      return entries
        .map((groupEntry) => attributesOf(groupEntry)[groupNameField]?.[0])
        .filter((name): name is string => Boolean(name))
    } catch (err: any) {
      WIKI.models.flags.authDebug(
        `LDAP strategy ${this.strategyId}: group search failed: ${err.message}`
      )
      return []
    }
  }

  /**
   * Mirrors 2.5.x's `getTlsOptions()`: no TLS cert path means "trust the system CA store (or don't
   * verify at all)"; a cert path is read once and cached, and only actually read from disk when
   * verification is on — reading an unused, possibly-empty path was 2.5.x's own bug (#2980).
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
