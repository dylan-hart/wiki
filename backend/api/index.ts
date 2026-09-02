import type { FastifyInstance } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'

/**
 * Registers every shared JSON Schema a route file may `$ref`.
 *
 * Exported (TEST-F2) so a test harness booting a subset of the route files registers the exact same
 * set this does, rather than each suite maintaining its own hand-picked list of `registerSchemas`
 * imports that drifts as schemas are added.
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
  // -> Named `registerParamsSchemas` rather than `registerSchemas` like its 33 neighbours: this file
  //    registers path-PARAMETER shapes, not an entity, and the distinct name is what keeps a route
  //    file's `params: { $ref: 'SiteIdParams#' }` traceable to it.
  await import('./schemas/params.ts').then((m) => m.registerParamsSchemas(app))
  await import('./schemas/scheduler.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/search.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/security.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/site.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/storage.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/tree.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/user.ts').then((m) => m.registerSchemas(app))
}

/**
 * API Routes
 */
async function routes(app: FastifyInstance) {
  // Register schemas
  await registerAllSchemas(app)

  // Register routes

  // -> `sites.ts` administers the site RECORD itself — including `PUT /sites/:siteId`, which is how
  //    `isEnabled` is flipped in either direction, and `DELETE /sites/:siteId`. Registered directly on
  //    `app`, outside the guarded `contentApp` encapsulation below, so both keep working on an already
  //    -disabled site: a `siteEnabledPreHandler` that also covered this route would make a
  //    disabled site permanently un-re-enableable through the API, since the very route that flips
  //    `isEnabled` back to `true` would itself already be refused with `isEnabled === false`. None of
  //    `sites.ts`'s own routes were ever among the nine hand-applied `guardSiteEnabled` call sites
  //    either — this preserves that, rather than changing it as a side effect of centralizing the rest.
  app.register(import('./sites.ts'), { prefix: '/sites' })

  // -> Every other `:siteId`-scoped route is genuinely site CONTENT or a site-scoped FEATURE (pages,
  //    the tree, assets, comments, navigation, search, storage targets, auth, blocks, approvals, ...),
  //    not administration of the site record — guarding these is exactly what OpenProject task 1593
  //    closes the hole on. A nested `register()` is a real Fastify encapsulation boundary: a hook
  //    added inside it (`contentApp.addHook`) applies only to routes registered within this same
  //    child scope and its own descendants, not to `sites.ts` above, which was registered directly on
  //    the outer `app`.
  app.register(async (contentApp) => {
    contentApp.addHook('preHandler', siteEnabledPreHandler)

    contentApp.register(import('./analytics.ts'))
    contentApp.register(import('./apiKeys.ts'), { prefix: '/api-keys' })
    contentApp.register(import('./approvals.ts'))
    contentApp.register(import('./assets.ts'))
    contentApp.register(import('./auditLog.ts'), { prefix: '/audit-log' })
    contentApp.register(import('./authentication.ts'))
    contentApp.register(import('./blockCredentials.ts'))
    contentApp.register(import('./blocks.ts'))
    contentApp.register(import('./bootstrap.ts'), { prefix: '/bootstrap' })
    contentApp.register(import('./checklists.ts'))
    contentApp.register(import('./classificationLevels.ts'), { prefix: '/classification-levels' })
    contentApp.register(import('./comments.ts'))
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
    contentApp.register(import('./pages.ts'))
    contentApp.register(import('./scheduler.ts'), { prefix: '/scheduler' })
    contentApp.register(import('./search.ts'))
    contentApp.register(import('./storage.ts'))
    contentApp.register(import('./system.ts'), { prefix: '/system' })
    contentApp.register(import('./tags.ts'))
    contentApp.register(import('./tree.ts'))
    contentApp.register(import('./users.ts'), { prefix: '/users' })
    contentApp.register(import('./watching.ts'))
  })
}

export default routes
