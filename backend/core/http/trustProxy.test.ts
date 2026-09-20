import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createHttpApp } from './server.ts'
import configSvc from '../config.ts'
import { createLiveTrustProxy } from './trustProxy.ts'
import { compileTrustProxy } from '../../helpers/security.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

const PROXY = '10.0.0.5'
const OTHER = '203.0.113.9'
const FORWARDED = {
  'x-forwarded-for': '198.51.100.7',
  'x-forwarded-host': 'forwarded.example.com',
  'x-forwarded-proto': 'https'
}

function setTrustProxy(value: unknown) {
  ;(globalThis as any).CARDINAL.config.security = { trustProxy: value }
}

describe('createHttpApp: trustProxy follows the live config', () => {
  let previous: unknown
  let app: FastifyInstance

  before(async () => {
    previous = (globalThis as any).CARDINAL
    installTestWiki({
      INSTANCE_ID: 'test-instance',
      ROOTPATH: process.cwd(),
      SERVERPATH: process.cwd(),
      sitesMappings: {},
      config: { bodyParserLimit: 0, logFormat: 'text', security: { trustProxy: false } }
    })
    app = createHttpApp()
    app.log.level = 'silent'
    app.get('/who', async (req) => ({ ip: req.ip, hostname: req.hostname, protocol: req.protocol }))
    await app.ready()
  })

  beforeEach(() => {
    setTrustProxy(false)
  })

  after(async () => {
    await app.close()
    ;(globalThis as any).CARDINAL?.server?.uninstall?.()
    ;(globalThis as any).CARDINAL = previous
  })

  async function whoAmI(remoteAddress: string) {
    const res = await app.inject({
      method: 'GET',
      url: '/who',
      remoteAddress,
      headers: { host: 'wiki.example.com', ...FORWARDED }
    })
    return res.json() as { ip: string; hostname: string; protocol: string }
  }

  test('starts with trustProxy off, ignoring forwarded headers from any peer', async () => {
    assert.deepEqual(await whoAmI(PROXY), {
      ip: PROXY,
      hostname: 'wiki.example.com',
      protocol: 'http'
    })
  })

  test('honours forwarded headers once trustProxy is switched to true, with no restart', async () => {
    setTrustProxy(true)
    assert.deepEqual(await whoAmI(OTHER), {
      ip: '198.51.100.7',
      hostname: 'forwarded.example.com',
      protocol: 'https'
    })
  })

  test('stops honouring them again when switched back to false', async () => {
    setTrustProxy(true)
    await whoAmI(OTHER)
    setTrustProxy(false)
    assert.deepEqual(await whoAmI(OTHER), {
      ip: OTHER,
      hostname: 'wiki.example.com',
      protocol: 'http'
    })
  })

  test('trusts only the peers a CIDR list covers, so an untrusted client cannot steer the hostname', async () => {
    setTrustProxy('10.0.0.0/8')
    assert.deepEqual(await whoAmI(PROXY), {
      ip: '198.51.100.7',
      hostname: 'forwarded.example.com',
      protocol: 'https'
    })
    assert.deepEqual(await whoAmI(OTHER), {
      ip: OTHER,
      hostname: 'wiki.example.com',
      protocol: 'http'
    })
  })

  test('re-reads a changed list: a peer outside the old list is trusted once it is added', async () => {
    setTrustProxy('10.0.0.0/8')
    assert.equal((await whoAmI(OTHER)).hostname, 'wiki.example.com')
    setTrustProxy('10.0.0.0/8, 203.0.113.0/24')
    assert.equal((await whoAmI(OTHER)).hostname, 'forwarded.example.com')
  })

  test('follows a reloadConfig from another instance: loadFromDb alone flips ip, hostname and protocol', async () => {
    ;(globalThis as any).CARDINAL.models = {
      settings: { getConfig: async () => ({ security: { trustProxy: '203.0.113.0/24' } }) }
    }
    assert.equal((await whoAmI(OTHER)).hostname, 'wiki.example.com')
    await configSvc.loadFromDb()
    assert.deepEqual(await whoAmI(OTHER), {
      ip: '198.51.100.7',
      hostname: 'forwarded.example.com',
      protocol: 'https'
    })
    ;(globalThis as any).CARDINAL.models = {
      settings: { getConfig: async () => ({ security: { trustProxy: false } }) }
    }
    await configSvc.loadFromDb()
    assert.equal((await whoAmI(OTHER)).hostname, 'wiki.example.com')
  })

  test('treats a blank string as off', async () => {
    setTrustProxy('   ')
    assert.equal((await whoAmI(PROXY)).hostname, 'wiki.example.com')
  })
})

describe('createLiveTrustProxy', () => {
  let previous: unknown
  const errors: unknown[][] = []

  before(() => {
    previous = (globalThis as any).CARDINAL
  })

  beforeEach(() => {
    errors.length = 0
    installTestWiki({
      config: { security: { trustProxy: '10.0.0.0/8' } },
      logger: {
        ...createSilentLogger(),
        error: (...args: unknown[]) => errors.push(args)
      }
    })
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previous
  })

  test('keeps the last valid list when the config later holds one that does not compile', () => {
    const trust = createLiveTrustProxy()
    assert.equal(trust(PROXY, 0), true)
    setTrustProxy('not-an-address')
    assert.equal(trust(PROXY, 0), true)
    assert.equal(trust(OTHER, 0), false)
    assert.equal(errors.length, 1)
    trust(PROXY, 0)
    assert.equal(errors.length, 1, 'the same bad value is reported once, not per request')
  })

  test('throws at construction for a list that does not compile, as Fastify did at boot', () => {
    setTrustProxy('not-an-address')
    assert.throws(() => createLiveTrustProxy())
  })

  test('false is always-false and true is trust-all', () => {
    assert.equal(compileTrustProxy(false)(PROXY, 0), false)
    assert.equal(compileTrustProxy(undefined)(PROXY, 0), false)
    assert.equal(compileTrustProxy(true)(OTHER, 3), true)
  })
})
