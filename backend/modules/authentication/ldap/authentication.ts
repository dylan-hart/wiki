/* global WIKI */
import fs from 'node:fs'
import { Client } from 'ldapts'
import type { Entry, SearchOptions, SearchResult } from 'ldapts'
import { ProvisionableLoginError } from '../../../models/authentication.ts'

/** Only what this module actually calls, kept narrow so a test double needs no more than this. */
type LdapClientFactory = (options: { url: string; tlsOptions: Record<string, any> }) => Client

/** Attribute values as ldapts hands them back: a bare value for a single-value attribute, an array for multi-value. */
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
 * trusted CA — as opposed to any other connection failure. `ldapts` does not normalize or wrap these;
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
 * #1232 / discussion #6891). `ldapts`'s own `InvalidCredentialsError` carries none of these codes, so
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

/** Best-effort: a connection that is already broken has nothing useful to report on unbind. */
async function unbindQuietly(client: Client): Promise<void> {
  try {
    await client.unbind()
  } catch {
    // Nothing to report on a connection that's already broken.
  }
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
   * @param createLdapClient Defaults to a real `ldapts` client. Overridable only so a test can hand
   *   in a double instead of talking to a real directory server.
   */
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
    // -> Distinct from the misconfiguration guard above: this is a bad *credential*, not a bad
    //    *strategy*. `ldapts`'s BindRequest defaults a missing password to `''` and sends it as a
    //    simple-auth bind, which RFC 4513 defines as an unauthenticated bind that many directories
    //    (Active Directory by default) answer with success against any DN that resolves — refuse it
    //    here, before the verification bind is ever attempted.
    if (!password) {
      WIKI.models.flags.authDebug(
        `LDAP strategy ${this.strategyId}: refused an empty/missing password for "${username}"`
      )
      throw new Error('ERR_LOGIN_FAILED')
    }

    let tlsOptions: Record<string, any>
    try {
      tlsOptions = this.getTlsOptions()
    } catch (err: any) {
      WIKI.logger.warn('auth', 'could not read the LDAP strategy TLS certificate', {
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

      let result: SearchResult
      try {
        result = await adminClient.search(searchBase, {
          scope: 'sub',
          filter: interpolate(searchFilter, { username: escapeFilterValue(username) })
        })
      } catch (err: any) {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: user search failed: ${err.message}`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }

      const entries = result.searchEntries
      if (entries.length !== 1) {
        WIKI.models.flags.authDebug(
          `LDAP strategy ${this.strategyId}: search for "${username}" returned ${entries.length} entries`
        )
        throw new Error('ERR_LOGIN_FAILED')
      }
      const entry = entries[0]
      const dn = entry.dn
      if (!dn) {
        throw new Error('ERR_LOGIN_FAILED')
      }

      // -> The actual credential check: bind as the DN the search found, with the password supplied.
      //    A separate client/connection than the admin one — this bind's only job is to succeed or
      //    fail, and doing it on its own connection keeps a failed attempt from ever touching the
      //    connection still needed for the optional group search below.
      const userClient = this.createLdapClient({ url, tlsOptions })
      try {
        await userClient.bind(dn, password)
      } catch {
        WIKI.models.flags.authDebug(
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
      await unbindQuietly(adminClient)
    }
  }

  /**
   * Directory groups for the user just verified, by name — matched against wiki groups of the same
   * name by `models/users.ts`'s `syncProviderGroups()`, not here.
   *
   * `{{dn}}` is interpolated from `groupDnProperty`: "dn" (the default, and not a real attribute
   * ldapts would ever return) means the user entry's own distinguished name; anything else names an
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
      const { searchEntries } = await client.search(groupSearchBase, {
        scope: (groupSearchScope as SearchOptions['scope']) || 'sub',
        filter: interpolate(groupSearchFilter, { dn: escapeFilterValue(dnValue) })
      })
      return searchEntries
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
