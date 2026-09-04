import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { localizedPagePath } from '@/helpers/pagePaths'

const routes = [
  {
    path: '/login',
    component: () => import('@/layouts/AuthLayout.vue'),
    children: [
      { path: '', component: () => import('@/pages/Login.vue') },
      /*
        Where `mail.ts`'s forgot-password email points (`buildLink('/login/reset-password/:token')`).
        Same page as plain `/login` -- `AuthLoginPanel.vue` reads the token straight off
        `window.location.pathname` in its mount logic and switches itself to the reset screen, so this
        route exists only to stop the path from falling through to the wiki-page catch-all below.
      */
      { path: 'reset-password/:token', component: () => import('@/pages/Login.vue') }
    ]
  },
  {
    path: '/a/:alias',
    component: () => import('@/layouts/MainLayout.vue'),
    beforeEnter: async (to) => {
      const pageStore = usePageStore()
      const siteStore = useSiteStore()
      try {
        const target = await pageStore.pageAlias(to.params.alias)
        return localizedPagePath(target.path, target.locale, siteStore.localeRouting)
      } catch (err) {
        return '/_error/notfound'
      }
    }
  },
  {
    path: '/_profile',
    component: () => import('@/layouts/ProfileLayout.vue'),
    children: [
      { path: '', redirect: '/_profile/info' },
      { path: 'info', component: () => import('@/pages/ProfileInfo.vue') },
      { path: 'avatar', component: () => import('@/pages/ProfileAvatar.vue') },
      { path: 'auth', component: () => import('@/pages/ProfileAuth.vue') },
      { path: 'groups', component: () => import('@/pages/ProfileGroups.vue') },
      { path: 'api', component: () => import('@/pages/ProfileApi.vue') },
      { path: 'notifications', component: () => import('@/pages/ProfileNotifications.vue') }
    ]
  },
  {
    path: '/_search',
    component: () => import('@/pages/Search.vue')
  },
  {
    path: '/_tags',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('@/pages/TagsBrowse.vue') }]
  },
  {
    path: '/_admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      { path: '', redirect: '/_admin/dashboard' },
      { path: 'dashboard', component: () => import('@/pages/AdminDashboard.vue') },
      { path: 'sites', component: () => import('@/pages/AdminSites.vue') },
      // -> Site
      { path: ':siteid/general', component: () => import('@/pages/AdminGeneral.vue') },
      { path: ':siteid/analytics', component: () => import('@/pages/AdminAnalytics.vue') },
      { path: ':siteid/approvals', component: () => import('@/pages/AdminApprovals.vue') },
      { path: ':siteid/blocks', component: () => import('@/pages/AdminBlocks.vue') },
      { path: ':siteid/editors', component: () => import('@/pages/AdminEditors.vue') },
      { path: ':siteid/glossary', component: () => import('@/pages/AdminGlossary.vue') },
      { path: ':siteid/locale', component: () => import('@/pages/AdminLocale.vue') },
      { path: ':siteid/login', component: () => import('@/pages/AdminLogin.vue') },
      { path: ':siteid/navigation', component: () => import('@/pages/AdminNavigation.vue') },
      { path: ':siteid/pages', component: () => import('@/pages/AdminPages.vue') },
      { path: ':siteid/pages/deleted', component: () => import('@/pages/AdminPagesDeleted.vue') },
      { path: ':siteid/storage/:id?', component: () => import('@/pages/AdminStorage.vue') },
      { path: ':siteid/comments', component: () => import('@/pages/AdminComments.vue') },
      { path: ':siteid/theme', component: () => import('@/pages/AdminTheme.vue') },
      // -> Users
      { path: 'auth', component: () => import('@/pages/AdminAuth.vue') },
      { path: 'groups/:id?/:section?', component: () => import('@/pages/AdminGroups.vue') },
      { path: 'users/:id?/:section?', component: () => import('@/pages/AdminUsers.vue') },
      // -> System
      { path: 'api', component: () => import('@/pages/AdminApi.vue') },
      { path: 'audit', component: () => import('@/pages/AdminAuditLog.vue') },
      { path: 'classification', component: () => import('@/pages/AdminClassification.vue') },
      { path: 'cluster', component: () => import('@/pages/AdminCluster.vue') },
      { path: 'extensions', component: () => import('@/pages/AdminExtensions.vue') },
      { path: 'icons', component: () => import('@/pages/AdminIcons.vue') },
      { path: 'mail', component: () => import('@/pages/AdminMail.vue') },
      { path: 'metrics', component: () => import('@/pages/AdminMetrics.vue') },
      { path: 'pageviews', component: () => import('@/pages/AdminPageviews.vue') },
      { path: 'replication', component: () => import('@/pages/AdminReplication.vue') },
      { path: 'scheduler', component: () => import('@/pages/AdminScheduler.vue') },
      { path: 'search', component: () => import('@/pages/AdminSearch.vue') },
      { path: 'security', component: () => import('@/pages/AdminSecurity.vue') },
      { path: 'system', component: () => import('@/pages/AdminSystem.vue') },
      { path: 'terminal', component: () => import('@/pages/AdminTerminal.vue') },
      { path: 'utilities', component: () => import('@/pages/AdminUtilities.vue') },
      { path: 'webhooks', component: () => import('@/pages/AdminWebhooks.vue') },
      { path: 'flags', component: () => import('@/pages/AdminFlags.vue') }
    ]
  },
  {
    path: '/_error/:action?',
    component: () => import('@/pages/ErrorGeneric.vue')
  },
  {
    path: '/_graph',
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Graph.vue') }]
  },

  // --------------------------------
  // CREATE
  // --------------------------------
  {
    path: '/_create/:editor?',
    // -> See the STANDARD PAGE CATCH-ALL route below for what this meta flag is for.
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  },
  // --------------------------------
  // EDIT
  // --------------------------------
  {
    /*
      A custom regex rather than the `*` repeat modifier `/:catchAll(.*)*` uses below: `*` turns the
      param into an array of segments, but `pagePath` is handed straight to `pageEdit({ path })` as a
      single string (see `Index.vue`'s route watcher) -- `(.*)` matches every segment of a nested path
      in one capture without changing that shape, and the trailing `?` keeps `/_edit` alone valid too.
    */
    path: '/_edit/:pagePath(.*)?',
    // -> See the STANDARD PAGE CATCH-ALL route below for what this meta flag is for.
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  },
  // -----------------------
  // STANDARD PAGE CATCH-ALL
  // -----------------------
  {
    path: '/:catchAll(.*)*',
    /*
      OpenProject #2512: `meta.contentPage` marks the three routes that actually render `Index.vue`
      and therefore run a page through `pageStore.pageLoad()` -- this one, `/_create`, and `/_edit`
      above. `MainLayout.vue`'s `effectiveNavigationId` (read by both `isSidebarMini` and
      `NavSidebar.vue`'s own nav-loading watcher) reads this flag to decide whether to trust
      `pageStore.navigationId` at all: only these three routes ever call `pageLoad()`, so on every
      OTHER `/_`-prefixed route (the knowledge graph, tags browse, admin, profile, ...)
      `pageStore.navigationId` is either `null` on a fresh store or whatever a previously-viewed
      content page left behind -- neither of which says anything about that route's own navigation.
      Those non-content routes fall back to the site's own default id instead (OpenProject #2527).
    */
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  }
]

export default routes
