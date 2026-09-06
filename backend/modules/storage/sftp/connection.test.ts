import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import { connectSftp, ensureDirectory, type SftpTargetConfig } from './connection.ts'

/** A password-auth config with sane defaults, overridden per test. */
function makeConfig(overrides: Partial<SftpTargetConfig> = {}): SftpTargetConfig {
  return {
    host: 'sftp.example.com',
    port: 22,
    username: 'wiki',
    authMode: 'password',
    password: 'hunter2',
    basePath: '/srv/wiki',
    ...overrides
  }
}

/**
 * A stub matching just the `Client` surface `connectSftp`/`ensureDirectory` call, built with
 * `mock.fn()` per the `test/mocks.ts` convention so a test can assert on `.mock.calls` directly rather
 * than reaching for a real `ssh2-sftp-client` connection.
 */
function makeStubClient(overrides: Record<string, any> = {}): any {
  return {
    connect: mock.fn(async () => {}),
    exists: mock.fn(async () => 'd' as const),
    put: mock.fn(async () => 'ok'),
    delete: mock.fn(async () => 'ok'),
    mkdir: mock.fn(async () => 'ok'),
    end: mock.fn(async () => true),
    ...overrides
  }
}

describe('connectSftp — auth config validation', () => {
  test('throws before ever connecting when authMode=password and password is empty', async () => {
    const client = makeStubClient()
    const config = makeConfig({ authMode: 'password', password: '' })

    await assert.rejects(
      connectSftp(config, () => client as unknown as Client),
      /uses password authentication, but no password is configured/
    )
    assert.equal(client.connect.mock.calls.length, 0)
  })

  test('throws before ever connecting when authMode=password and password is undefined', async () => {
    const client = makeStubClient()
    const config = makeConfig({ authMode: 'password', password: undefined })

    await assert.rejects(
      connectSftp(config, () => client as unknown as Client),
      /uses password authentication, but no password is configured/
    )
    assert.equal(client.connect.mock.calls.length, 0)
  })

  test('throws before ever connecting when authMode=password and password is only whitespace', async () => {
    const client = makeStubClient()
    const config = makeConfig({ authMode: 'password', password: '   ' })

    await assert.rejects(
      connectSftp(config, () => client as unknown as Client),
      /uses password authentication, but no password is configured/
    )
    assert.equal(client.connect.mock.calls.length, 0)
  })

  test('throws before ever connecting when authMode=privateKey and privateKey is empty', async () => {
    const client = makeStubClient()
    const config = makeConfig({
      authMode: 'privateKey',
      password: undefined,
      privateKey: ''
    })

    await assert.rejects(
      connectSftp(config, () => client as unknown as Client),
      /uses private-key authentication, but no private key is configured/
    )
    assert.equal(client.connect.mock.calls.length, 0)
  })

  test('throws before ever connecting when authMode=privateKey and privateKey is undefined', async () => {
    const client = makeStubClient()
    const config = makeConfig({
      authMode: 'privateKey',
      password: undefined,
      privateKey: undefined
    })

    await assert.rejects(
      connectSftp(config, () => client as unknown as Client),
      /uses private-key authentication, but no private key is configured/
    )
    assert.equal(client.connect.mock.calls.length, 0)
  })

  test('does not require a passphrase for privateKey auth (it is optional)', async () => {
    const client = makeStubClient()
    const config = makeConfig({
      authMode: 'privateKey',
      password: undefined,
      privateKey: '-----BEGIN KEY-----',
      passphrase: undefined
    })

    await assert.doesNotReject(connectSftp(config, () => client as unknown as Client))
  })
})

describe('connectSftp', () => {
  test('connects with password auth and returns the connected client', async () => {
    const client = makeStubClient()
    const result = await connectSftp(makeConfig(), () => client as unknown as Client)

    assert.equal(result, client)
    assert.equal(client.connect.mock.calls.length, 1)
    const options = client.connect.mock.calls[0].arguments[0]
    assert.equal(options.host, 'sftp.example.com')
    assert.equal(options.port, 22)
    assert.equal(options.username, 'wiki')
    assert.equal(options.password, 'hunter2')
    assert.equal('privateKey' in options, false)
  })

  test('connects with private-key auth, including passphrase when set', async () => {
    const client = makeStubClient()
    const config = makeConfig({
      authMode: 'privateKey',
      password: undefined,
      privateKey: '-----BEGIN KEY-----',
      passphrase: 'secret'
    })
    await connectSftp(config, () => client as unknown as Client)

    const options = client.connect.mock.calls[0].arguments[0]
    assert.equal(options.privateKey, '-----BEGIN KEY-----')
    assert.equal(options.passphrase, 'secret')
    assert.equal('password' in options, false)
  })

  test('omits passphrase from the connect options when not set', async () => {
    const client = makeStubClient()
    const config = makeConfig({ authMode: 'privateKey', password: undefined, privateKey: 'key' })
    await connectSftp(config, () => client as unknown as Client)

    const options = client.connect.mock.calls[0].arguments[0]
    assert.equal('passphrase' in options, false)
  })

  test('throws a clear error when the connection itself fails (bad credentials / unreachable host)', async () => {
    const client = makeStubClient({
      connect: mock.fn(async () => {
        throw new Error('All configured authentication methods failed')
      })
    })

    await assert.rejects(
      connectSftp(makeConfig(), () => client as unknown as Client),
      (err: Error) => {
        assert.match(err.message, /Could not connect to sftp\.example\.com:22/)
        assert.match(err.message, /All configured authentication methods failed/)
        return true
      }
    )
    // -> Never connected, so there is nothing to close
    assert.equal(client.end.mock.calls.length, 0)
  })

  test('throws a clear error and closes the connection when basePath does not exist', async () => {
    const client = makeStubClient({ exists: mock.fn(async () => false) })

    await assert.rejects(
      connectSftp(makeConfig(), () => client as unknown as Client),
      /does not exist/
    )
    assert.equal(client.end.mock.calls.length, 1)
  })

  test('throws a clear error when basePath exists but is not a directory', async () => {
    const client = makeStubClient({ exists: mock.fn(async () => '-' as const) })

    await assert.rejects(
      connectSftp(makeConfig(), () => client as unknown as Client),
      /is not a directory/
    )
    assert.equal(client.end.mock.calls.length, 1)
  })

  test('throws a clear error and closes the connection when basePath is not writable', async () => {
    const client = makeStubClient({
      put: mock.fn(async () => {
        throw new Error('Permission denied')
      })
    })

    await assert.rejects(
      connectSftp(makeConfig(), () => client as unknown as Client),
      (err: Error) => {
        assert.match(err.message, /not writable/)
        assert.match(err.message, /Permission denied/)
        return true
      }
    )
    assert.equal(client.end.mock.calls.length, 1)
  })

  test('cleans up the write-test marker file after verifying basePath', async () => {
    const client = makeStubClient()
    await connectSftp(makeConfig(), () => client as unknown as Client)

    assert.equal(client.put.mock.calls.length, 1)
    assert.equal(client.delete.mock.calls.length, 1)
    const putPath = client.put.mock.calls[0].arguments[1]
    const deletePath = client.delete.mock.calls[0].arguments[0]
    assert.equal(putPath, deletePath)
    assert.match(putPath, /^\/srv\/wiki\/\.cardinaljs-write-test-/)
  })
})

describe('ensureDirectory', () => {
  test('creates every missing segment, one at a time', async () => {
    const client = makeStubClient({ exists: mock.fn(async () => false as const) })
    await ensureDirectory(client as unknown as Client, '/srv/wiki', 'en/guides/setup')

    assert.deepEqual(
      client.mkdir.mock.calls.map((c: any) => c.arguments[0]),
      ['/srv/wiki/en', '/srv/wiki/en/guides', '/srv/wiki/en/guides/setup']
    )
  })

  test('skips a segment that already exists as a directory', async () => {
    const existing = new Set(['/srv/wiki/en'])
    const client = makeStubClient({
      exists: mock.fn(async (p: string) => (existing.has(p) ? 'd' : false))
    })
    await ensureDirectory(client as unknown as Client, '/srv/wiki', 'en/guides')

    assert.deepEqual(
      client.mkdir.mock.calls.map((c: any) => c.arguments[0]),
      ['/srv/wiki/en/guides']
    )
  })

  test('is tolerant of a segment created concurrently between the exists check and mkdir', async () => {
    const client = makeStubClient({
      exists: mock.fn(async () => false as const),
      mkdir: mock.fn(async () => {
        throw new Error('Failure')
      })
    })
    // -> The recheck inside `ensureDirectory` also calls `exists`, which is stubbed to always return
    //    `false` above — override it so the *second* call (the recheck) reports the segment as now
    //    present, simulating another process having created it in between.
    let call = 0
    client.exists = mock.fn(async () => {
      call += 1
      return call === 1 ? false : 'd'
    })

    await assert.doesNotReject(ensureDirectory(client as unknown as Client, '/srv/wiki', 'en'))
  })

  test('throws when mkdir fails and the segment is still missing on recheck', async () => {
    const client = makeStubClient({
      exists: mock.fn(async () => false as const),
      mkdir: mock.fn(async () => {
        throw new Error('Disk full')
      })
    })

    await assert.rejects(
      ensureDirectory(client as unknown as Client, '/srv/wiki', 'en'),
      (err: Error) => {
        assert.match(err.message, /Could not create directory "\/srv\/wiki\/en"/)
        assert.match(err.message, /Disk full/)
        return true
      }
    )
  })

  test('throws when a segment exists but is a file, not a directory', async () => {
    const client = makeStubClient({ exists: mock.fn(async () => '-' as const) })

    await assert.rejects(
      ensureDirectory(client as unknown as Client, '/srv/wiki', 'en'),
      /is not a directory/
    )
    assert.equal(client.mkdir.mock.calls.length, 0)
  })

  test('does nothing for an empty relative path', async () => {
    const client = makeStubClient()
    await ensureDirectory(client as unknown as Client, '/srv/wiki', '')

    assert.equal(client.exists.mock.calls.length, 0)
    assert.equal(client.mkdir.mock.calls.length, 0)
  })
})
