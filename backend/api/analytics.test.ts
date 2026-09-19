import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import analyticsRoutes from './analytics.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

const FIXTURE_MODULES = [
  {
    key: 'google',
    title: 'Google Analytics',
    description: 'Tracks website traffic.',
    logo: 'https://static.requarks.io/logo/google-analytics.svg',
    website: 'https://analytics.google.com/',
    isAvailable: true,
    props: {
      propertyTrackingId: {
        default: '',
        type: 'string',
        title: 'Property Tracking ID',
        hint: 'G-XXXXXXXXXX',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 1,
        if: []
      }
    }
  }
]

let app: FastifyInstance
const routeConfigs: Record<string, any> = {}

before(async () => {
  // -> Fastify has no public API to read a route's `config` back, so capture it at registration.
  //    Wrapped around the plugin: `onRoute` only fires for routes registered into the same
  //    encapsulation or below it.
  const capturingRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('onRoute', (routeOptions: any) => {
      routeConfigs[`${routeOptions.method}:${routeOptions.url}`] = routeOptions.config
    })
    await instance.register(analyticsRoutes)
  }

  app = await buildTestApp({
    routes: capturingRoutes,
    wiki: {
      models: {
        analytics: {
          getModules: () => FIXTURE_MODULES
        }
      }
    }
  })
})

after(() => closeTestApp(app))

test('GET /analytics/modules declares manage:sites, not manage:system', () => {
  assert.deepEqual(routeConfigs['GET:/analytics/modules']?.permissions, ['manage:sites'])
})
