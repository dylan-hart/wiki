import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import analyticsRoutes from './analytics.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Coverage for Task 592's `GET /_api/analytics/modules` route: mirrors
 * `GET /_api/authentication/modules` in shape (reads `WIKI.models.analytics.getModules()`,
 * responds with the `AnalyticsModule#` array schema) and declares the same route-level permission
 * pattern (`config.permissions`), except `manage:sites` rather than `manage:system` since analytics
 * provider config is per-site (see `Site#/properties/analytics`), not instance-wide the way an
 * auth strategy's stored credentials are.
 */

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
  // -> Captures each route's `config.permissions` as it is registered, since Fastify does not expose
  //    a public, stable API to read it back afterwards — the same list the real permission
  //    `preHandler` hook is driven by. Wrapped around the route plugin, since an `onRoute` hook only
  //    fires for routes registered into the same encapsulation or below it.
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

test('GET /analytics/modules returns what the model discovered, unchanged', async () => {
  const res = await app.inject({ method: 'GET', url: '/analytics/modules' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), FIXTURE_MODULES)
})

test('GET /analytics/modules declares manage:sites, not manage:system', () => {
  assert.deepEqual(routeConfigs['GET:/analytics/modules']?.permissions, ['manage:sites'])
})
