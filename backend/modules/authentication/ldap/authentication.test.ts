import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import LdapAuthentication from './authentication.ts'
import { ProvisionableLoginError } from '../../../models/authentication.ts'
import { installTestWiki } from '../../../test/mocks.ts'

/**
 * `ldapts` talks to a real directory server, so this suite never touches the network: `authenticate()`
 * takes an injectable client factory (its only test-only seam), and every scenario here drives that
 * factory with a small fake standing in for a directory's promise-based bind/search behavior. What is
 * under test is this module's control flow and error mapping — search-then-bind, the zero/multiple-
 * entries and wrong-password edge cases, filter interpolation/escaping, group mapping, and TLS option
 * caching — not `ldapts` itself.
 */

const CONF = {
  url: 'ldaps://ldap.example.com:636',
  bindDn: 'cn=admin,dc=example,dc=com',
  bindCredentials: 'admin-secret',
  searchBase: 'ou=people,dc=example,dc=com',
  searchFilter: '(uid={{username}})',
  mappingUID: 'uid',
  mappingEmail: 'mail',
  mappingDisplayName: 'displayName'
}

interface FakeEntry {
  dn: string
  attrs: Record<string, string | string[]>
}

/** Shapes a fake entry the way `ldapts`'s `Client.search()` returns one: attributes flattened onto the entry itself, alongside `dn`. */
function toSearchEntry(entry: FakeEntry): any {
  return { dn: entry.dn, ...entry.attrs }
}

interface FakeDirectoryHandlers {
  /** Return `true` for a correct bind, or an `Error` for a rejected one. */
  bind: (dn: string, password: string) => true | Error
  /** Return the matching entries, or an `Error` to simulate the search itself failing. */
  search: (base: string, options: any) => FakeEntry[] | Error
}

/** Every `bind`/`search` call made against any client this factory produced, across the whole test. */
function makeClientFactory(handlers: FakeDirectoryHandlers) {
  const calls: {
    binds: Array<{ dn: string; password: string }>
    searches: Array<{ base: string; options: any }>
  } = { binds: [], searches: [] }

  const factory = (_options: any) => {
    const client: any = {
      bind: async (dn: string, password: string) => {
        calls.binds.push({ dn, password })
        const result = handlers.bind(dn, password)
        if (result !== true) {
          throw result
        }
      },
      search: async (base: string, options: any) => {
        calls.searches.push({ base, options })
        const result = handlers.search(base, options)
        if (result instanceof Error) {
          throw result
        }
        return { searchEntries: result.map(toSearchEntry), searchReferences: [] }
      },
      unbind: async () => {}
    }
    return client
  }

  return { factory, calls }
}

let wikiHandle: { restore(): void }

before(() => {
  wikiHandle = installTestWiki({ models: { flags: { authDebug: () => {} } } })
})

after(() => {
  wikiHandle.restore()
})

let clientFactoryCallCount = 0
beforeEach(() => {
  clientFactoryCallCount = 0
})

test('required config missing rejects as ERR_STRATEGY_MISCONFIGURED without contacting the directory', async () => {
  const { factory } = makeClientFactory({
    bind: () => {
      throw new Error('should not be called')
    },
    search: () => {
      throw new Error('should not be called')
    }
  })
  const countingFactory = (options: any) => {
    clientFactoryCallCount++
    return factory(options)
  }
  const mod = new LdapAuthentication('strategy-1', { ...CONF, bindDn: '' }, countingFactory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_STRATEGY_MISCONFIGURED/
  )
  assert.equal(clientFactoryCallCount, 0)
})

test('an empty-string password rejects as ERR_LOGIN_FAILED without ever contacting the directory', async () => {
  const { factory, calls } = makeClientFactory({
    bind: () => {
      throw new Error('should not be called')
    },
    search: () => {
      throw new Error('should not be called')
    }
  })
  const countingFactory = (options: any) => {
    clientFactoryCallCount++
    return factory(options)
  }
  const mod = new LdapAuthentication('strategy-1', CONF, countingFactory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: '' }), /ERR_LOGIN_FAILED/)
  // -> Not just "the verification bind never happened" -- no client (not even the admin one) was
  //    ever created, and no bind of any kind was attempted with the resolved DN.
  assert.equal(clientFactoryCallCount, 0)
  assert.equal(calls.binds.length, 0)
})

test('an omitted (undefined) password rejects as ERR_LOGIN_FAILED without ever contacting the directory', async () => {
  const { factory, calls } = makeClientFactory({
    bind: () => {
      throw new Error('should not be called')
    },
    search: () => {
      throw new Error('should not be called')
    }
  })
  const countingFactory = (options: any) => {
    clientFactoryCallCount++
    return factory(options)
  }
  const mod = new LdapAuthentication('strategy-1', CONF, countingFactory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: undefined as any }),
    /ERR_LOGIN_FAILED/
  )
  assert.equal(clientFactoryCallCount, 0)
  assert.equal(calls.binds.length, 0)
})

test('admin bind failure surfaces as ERR_STRATEGY_MISCONFIGURED, not a generic login failure', async () => {
  const { factory } = makeClientFactory({
    bind: (dn) => (dn === CONF.bindDn ? new Error('InvalidCredentialsError') : true),
    search: () => {
      throw new Error('should not be reached')
    }
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_STRATEGY_MISCONFIGURED/
  )
})

test('a search returning zero entries rejects as ERR_LOGIN_FAILED', async () => {
  const { factory } = makeClientFactory({
    bind: () => true,
    search: () => []
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }), /ERR_LOGIN_FAILED/)
})

test('a search returning multiple entries rejects as ERR_LOGIN_FAILED (ambiguous match)', async () => {
  const { factory } = makeClientFactory({
    bind: () => true,
    search: () => [
      {
        dn: 'uid=jdoe,ou=people,dc=example,dc=com',
        attrs: { uid: 'jdoe', mail: 'jdoe@example.com' }
      },
      {
        dn: 'uid=jdoe2,ou=people,dc=example,dc=com',
        attrs: { uid: 'jdoe', mail: 'jdoe2@example.com' }
      }
    ]
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }), /ERR_LOGIN_FAILED/)
})

test('a search that errors outright rejects as ERR_LOGIN_FAILED', async () => {
  const { factory } = makeClientFactory({
    bind: () => true,
    search: () => new Error('TimeLimitExceededError')
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }), /ERR_LOGIN_FAILED/)
})

test('user found by search but the verification bind fails (wrong password) rejects as ERR_LOGIN_FAILED', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const { factory, calls } = makeClientFactory({
    bind: (dn, password) => {
      if (dn === CONF.bindDn) {
        return true
      }
      // -> The verification bind: only the real password is accepted.
      return dn === userDn && password === 'correct-password'
        ? true
        : new Error('InvalidCredentialsError')
    },
    search: () => [{ dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com' } }]
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'wrong-password' }),
    /ERR_LOGIN_FAILED/
  )
  // -> The entry really was found — this must not be indistinguishable from "never even searched" at
  //    the level of what got called, only in the error it produces.
  assert.equal(
    calls.binds.some((b) => b.dn === userDn),
    true
  )
})

test('a correct password verifies and hands back a ProvisionableLoginError carrying the mapped profile', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const { factory } = makeClientFactory({
    bind: (dn, password) => {
      if (dn === CONF.bindDn) {
        return true
      }
      return dn === userDn && password === 'correct-password'
        ? true
        : new Error('InvalidCredentialsError')
    },
    search: () => [
      { dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com', displayName: 'Jane Doe' } }
    ]
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'correct-password' }),
    (err: any) => {
      assert.ok(err instanceof ProvisionableLoginError)
      assert.deepEqual(err.profile, {
        id: 'jdoe',
        email: 'jdoe@example.com',
        name: 'Jane Doe',
        groups: undefined
      })
      return true
    }
  )
})

test('falls back to the email address as the display name when displayName is unmapped', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const { factory } = makeClientFactory({
    bind: () => true,
    search: () => [{ dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com' } }]
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'correct-password' }),
    (err: any) => {
      assert.equal(err.profile.name, 'jdoe@example.com')
      return true
    }
  )
})

test('an entry missing its unique ID or email mapping rejects as ERR_LOGIN_FAILED', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const { factory } = makeClientFactory({
    bind: () => true,
    // -> No `mail` attribute on this entry.
    search: () => [{ dn: userDn, attrs: { uid: 'jdoe' } }]
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }), /ERR_LOGIN_FAILED/)
})

test('interpolates {{username}} into the search filter, escaping LDAP filter metacharacters', async () => {
  const { factory, calls } = makeClientFactory({
    bind: () => true,
    search: () => []
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(mod.authenticate({ username: '*)(uid=*', password: 'pw' }))

  const searchCall = calls.searches.find((s) => s.base === CONF.searchBase)
  assert.equal(searchCall?.options.filter, '(uid=\\2a\\29\\28uid=\\2a)')
})

test('mapGroups off: no group search happens and profile.groups is left undefined', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const { factory, calls } = makeClientFactory({
    bind: () => true,
    search: (base) => {
      if (base === CONF.searchBase) {
        return [{ dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com' } }]
      }
      throw new Error(`unexpected search against ${base}`)
    }
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'correct-password' }),
    (err: any) => {
      assert.equal(err.profile.groups, undefined)
      return true
    }
  )
  assert.equal(calls.searches.length, 1)
})

test("mapGroups on: searches groupSearchBase with {{dn}} from the entry's own DN by default, collecting groupNameField", async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const conf = {
    ...CONF,
    mapGroups: true,
    groupSearchBase: 'ou=groups,dc=example,dc=com',
    groupSearchFilter: '(member={{dn}})',
    groupSearchScope: 'sub',
    groupDnProperty: 'dn',
    groupNameField: 'cn'
  }
  const { factory, calls } = makeClientFactory({
    bind: () => true,
    search: (base) => {
      if (base === conf.searchBase) {
        return [{ dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com' } }]
      }
      if (base === conf.groupSearchBase) {
        return [
          { dn: 'cn=editors,ou=groups,dc=example,dc=com', attrs: { cn: 'editors' } },
          { dn: 'cn=admins,ou=groups,dc=example,dc=com', attrs: { cn: 'admins' } }
        ]
      }
      throw new Error(`unexpected search against ${base}`)
    }
  })
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'correct-password' }),
    (err: any) => {
      assert.deepEqual(err.profile.groups, ['editors', 'admins'])
      return true
    }
  )

  const groupSearch = calls.searches.find((s) => s.base === conf.groupSearchBase)
  assert.equal(groupSearch?.options.filter, `(member=${userDn})`)
  assert.equal(groupSearch?.options.scope, 'sub')
})

test('mapGroups on with a non-dn groupDnProperty interpolates from that attribute on the user entry', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const conf = {
    ...CONF,
    mapGroups: true,
    groupSearchBase: 'ou=groups,dc=example,dc=com',
    groupSearchFilter: '(member={{dn}})',
    groupDnProperty: 'entryUUID',
    groupNameField: 'cn'
  }
  const { calls, factory } = makeClientFactory({
    bind: () => true,
    search: (base) => {
      if (base === conf.searchBase) {
        return [
          {
            dn: userDn,
            attrs: { uid: 'jdoe', mail: 'jdoe@example.com', entryUUID: 'abc-123' }
          }
        ]
      }
      if (base === conf.groupSearchBase) {
        return []
      }
      throw new Error(`unexpected search against ${base}`)
    }
  })
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'correct-password' }))

  const groupSearch = calls.searches.find((s) => s.base === conf.groupSearchBase)
  assert.equal(groupSearch?.options.filter, '(member=abc-123)')
})

test('a failing group search does not fail the login — profile.groups just comes back empty', async () => {
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const conf = {
    ...CONF,
    mapGroups: true,
    groupSearchBase: 'ou=groups,dc=example,dc=com',
    groupSearchFilter: '(member={{dn}})',
    groupNameField: 'cn'
  }
  const { factory } = makeClientFactory({
    bind: () => true,
    search: (base) => {
      if (base === conf.searchBase) {
        return [{ dn: userDn, attrs: { uid: 'jdoe', mail: 'jdoe@example.com' } }]
      }
      return new Error('OperationsError')
    }
  })
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'correct-password' }),
    (err: any) => {
      assert.deepEqual(err.profile.groups, [])
      return true
    }
  )
})

test('TLS certificate is read from disk once and cached across logins', async () => {
  const tmpFile = path.join(os.tmpdir(), `ldap-test-ca-${Date.now()}.pem`)
  fs.writeFileSync(tmpFile, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n')
  const userDn = 'uid=jdoe,ou=people,dc=example,dc=com'
  const conf = { ...CONF, tlsEnabled: true, verifyTLSCertificate: true, tlsCertPath: tmpFile }
  const seenTlsOptions: any[] = []
  const factory = (options: any) => {
    seenTlsOptions.push(options.tlsOptions)
    const client: any = {
      bind: async () => {},
      search: async () => ({
        searchEntries: [toSearchEntry({ dn: userDn, attrs: { uid: 'jdoe', mail: 'j@x.com' } })],
        searchReferences: []
      }),
      unbind: async () => {}
    }
    return client
  }
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }))
  // -> The file is gone now; a second read would throw ENOENT if the cache were not being reused.
  fs.rmSync(tmpFile)
  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }))

  assert.equal(seenTlsOptions.length, 4) // 2 logins * (admin client + user client)
  for (const opts of seenTlsOptions) {
    assert.equal(opts.rejectUnauthorized, true)
    assert.equal(Buffer.isBuffer(opts.ca[0]), true)
  }
})

test('a TLS certificate path that cannot be read rejects as ERR_STRATEGY_MISCONFIGURED', async () => {
  const conf = {
    ...CONF,
    tlsEnabled: true,
    verifyTLSCertificate: true,
    tlsCertPath: '/nonexistent/path/to/ca.pem'
  }
  const { factory } = makeClientFactory({
    bind: () => {
      throw new Error('should not be called')
    },
    search: () => {
      throw new Error('should not be called')
    }
  })
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_STRATEGY_MISCONFIGURED/
  )
})

test('a custom/internal CA at tlsCertPath is handed to the LDAP client verbatim, alongside the system trust store', async () => {
  const tmpFile = path.join(os.tmpdir(), `ldap-test-custom-ca-${Date.now()}.pem`)
  const caPem = '-----BEGIN CERTIFICATE-----\ninternal-ca-fixture\n-----END CERTIFICATE-----\n'
  fs.writeFileSync(tmpFile, caPem)
  const conf = { ...CONF, tlsEnabled: true, verifyTLSCertificate: true, tlsCertPath: tmpFile }
  const seenTlsOptions: any[] = []
  const factory = (options: any) => {
    seenTlsOptions.push(options.tlsOptions)
    const client: any = {
      bind: async (dn: string) => {
        if (dn !== CONF.bindDn) {
          throw new Error('InvalidCredentialsError')
        }
      },
      search: async () => ({ searchEntries: [], searchReferences: [] }),
      unbind: async () => {}
    }
    return client
  }
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }))
  fs.rmSync(tmpFile)

  assert.equal(seenTlsOptions.length > 0, true)
  assert.equal(seenTlsOptions[0].ca[0].toString(), caPem)
})

test('verifyTLSCertificate off never reads tlsCertPath from disk, even when one is configured (2.5.x #2980)', async () => {
  const conf = {
    ...CONF,
    tlsEnabled: true,
    verifyTLSCertificate: false,
    tlsCertPath: '/nonexistent/path/never-read.pem'
  }
  const seenTlsOptions: any[] = []
  const factory = (options: any) => {
    seenTlsOptions.push(options.tlsOptions)
    const client: any = {
      bind: async (dn: string) => {
        if (dn !== CONF.bindDn) {
          throw new Error('InvalidCredentialsError')
        }
      },
      search: async () => ({ searchEntries: [], searchReferences: [] }),
      unbind: async () => {}
    }
    return client
  }
  const mod = new LdapAuthentication('strategy-1', conf, factory)

  // -> Would throw ENOENT trying to read the nonexistent path if this were not skipped.
  await assert.rejects(mod.authenticate({ username: 'jdoe', password: 'pw' }))
  assert.equal(seenTlsOptions[0].rejectUnauthorized, false)
  assert.deepEqual(seenTlsOptions[0].ca, [])
})

test('an admin bind failing on an untrusted TLS certificate rejects as ERR_LDAP_CERTIFICATE_NOT_TRUSTED, distinct from a bad admin password', async () => {
  const tlsErr: any = new Error('self signed certificate in certificate chain')
  tlsErr.code = 'SELF_SIGNED_CERT_IN_CHAIN'
  const { factory } = makeClientFactory({
    bind: () => tlsErr,
    search: () => {
      throw new Error('should not be reached')
    }
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_LDAP_CERTIFICATE_NOT_TRUSTED/
  )
})

test('an admin bind failing on an untrusted TLS certificate is recognized from message text alone, when the error carries no `code`', async () => {
  const { factory } = makeClientFactory({
    bind: () => new Error('unable to verify the first certificate'),
    search: () => {
      throw new Error('should not be reached')
    }
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_LDAP_CERTIFICATE_NOT_TRUSTED/
  )
})

test('an admin bind failing on genuinely wrong credentials still rejects as ERR_STRATEGY_MISCONFIGURED, not the certificate-trust error', async () => {
  const { factory } = makeClientFactory({
    bind: () => new Error('InvalidCredentialsError'),
    search: () => {
      throw new Error('should not be reached')
    }
  })
  const mod = new LdapAuthentication('strategy-1', CONF, factory)

  await assert.rejects(
    mod.authenticate({ username: 'jdoe', password: 'pw' }),
    /ERR_STRATEGY_MISCONFIGURED/
  )
})
