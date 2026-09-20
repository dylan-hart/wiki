import type { FastifyInstance } from 'fastify'
import { apiReadinessOnRequest } from '../helpers/apiReadiness.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'

/**
 * Exported so a test harness booting a subset of the route files registers the exact set this does,
 * rather than a hand-picked list that drifts as schemas are added.
 */
export async function registerAllSchemas(app: FastifyInstance) {
  await import('./schemas/analytics.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/apiKey.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/approval.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/asset.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/auditLog.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/authentication.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/block.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/blockCredential.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/checklist.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/classificationLevel.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/comment.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/commentProvider.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/diagram.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/error.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/extension.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/flags.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/glossaryTerm.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/graph.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/group.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/hook.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/icon.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/mail.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/navigation.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/notification.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/page.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/pageImport.ts').then((m) => m.registerSchemas(app))
  // -> `registerParamsSchemas`, not `registerSchemas`: path-parameter shapes, not an entity.
  await import('./schemas/params.ts').then((m) => m.registerParamsSchemas(app))
  await import('./schemas/replication.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/scheduler.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/search.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/security.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/site.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/storage.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/tree.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/user.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/watcher.ts').then((m) => m.registerSchemas(app))
}

async function routes(app: FastifyInstance) {
  // -> 503 (+ `Retry-After`) until `postBoot()` has filled the caches every route reads from:
  //    `app.listen()` accepts connections before it runs. Registered first, so it covers `sites.ts`
  //    below as well as the `contentApp` scope.
  app.addHook('onRequest', apiReadinessOnRequest)

  await registerAllSchemas(app)

  // -> Registered outside the guarded `contentApp` scope: `PUT /sites/:siteId` is how `isEnabled`
  //    is flipped back to `true`, so a `siteEnabledPreHandler` covering it would make a disabled
  //    site permanently un-re-enableable through the API.
  app.register(import('./sites.ts'), { prefix: '/sites' })

  // -> A nested `register()` is a real encapsulation boundary: the hook applies only to routes
  //    registered within this child scope, not to `sites.ts` above.
  app.register(async (contentApp) => {
    contentApp.addHook('preHandler', siteEnabledPreHandler)

    contentApp.register(import('./analytics.ts'))
    contentApp.register(import('./apiKeys.ts'), { prefix: '/api-keys' })
    contentApp.register(import('./approvals.ts'))
    contentApp.register(import('./assets.ts'))
    contentApp.register(import('./auditLog.ts'), { prefix: '/audit-log' })
    contentApp.register(import('./auth/index.ts'))
    contentApp.register(import('./blockCredentials.ts'))
    contentApp.register(import('./blocks.ts'))
    contentApp.register(import('./bootstrap.ts'), { prefix: '/bootstrap' })
    contentApp.register(import('./checklists.ts'))
    contentApp.register(import('./classificationLevels.ts'), { prefix: '/classification-levels' })
    contentApp.register(import('./comments.ts'))
    contentApp.register(import('./diagramProxy.ts'))
    contentApp.register(import('./diagrams.ts'), { prefix: '/diagrams' })
    contentApp.register(import('./glossary.ts'))
    contentApp.register(import('./graph.ts'))
    contentApp.register(import('./groups.ts'), { prefix: '/groups' })
    contentApp.register(import('./hooks.ts'), { prefix: '/hooks' })
    contentApp.register(import('./icons.ts'), { prefix: '/icons' })
    contentApp.register(import('./liveData.ts'))
    contentApp.register(import('./locales.ts'), { prefix: '/locales' })
    contentApp.register(import('./mail.ts'), { prefix: '/mail' })
    contentApp.register(import('./navigation.ts'))
    contentApp.register(import('./notifications.ts'))
    contentApp.register(import('./pages/index.ts'))
    contentApp.register(import('./pageviews.ts'))
    contentApp.register(import('./replication.ts'), { prefix: '/replication' })
    contentApp.register(import('./scheduler.ts'), { prefix: '/scheduler' })
    contentApp.register(import('./search.ts'))
    contentApp.register(import('./storage.ts'))
    contentApp.register(import('./system/index.ts'), { prefix: '/system' })
    contentApp.register(import('./tags.ts'))
    contentApp.register(import('./tree.ts'))
    contentApp.register(import('./users/index.ts'), { prefix: '/users' })
    contentApp.register(import('./watching.ts'))
  })
}

export default routes
