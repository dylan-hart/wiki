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
        Where the forgot-password email points. `AuthLoginPanel.vue` reads the token straight off
        `window.location.pathname` and switches itself to the reset screen, so this route exists
        only to stop the path falling through to the wiki-page catch-all below.
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
    path: '/i/:id',
    component: () => import('@/layouts/MainLayout.vue'),
    beforeEnter: async (to) => {
      const pageStore = usePageStore()
      const siteStore = useSiteStore()
      try {
        const target = await pageStore.pageById(to.params.id)
        return localizedPagePath(target.path, target.locale, siteStore.localeRouting)
      } catch (err) {
        return '/_error/notfound'
      }
    }
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
    path: '/_tasks',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('@/pages/TasksRollup.vue') }]
  },
  {
    path: '/_version/:id',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('@/pages/PageVersion.vue') }]
  },
  {
    path: '/_admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      { path: '', redirect: '/_admin/dashboard' },
      { path: 'dashboard', component: () => import('@/pages/AdminDashboard.vue') },
      { path: 'sites', component: () => import('@/pages/AdminSites.vue') },
      /*
        `AdminPageEyebrow.vue`'s sectionKey reads `meta.siteScoped` -- explicit here rather than
        inferred from path shape, since `groups/:id?/:section?` and `users/:id?/:section?` below can
        carry just as many path segments without being site-scoped.
      */
      {
        path: ':siteid/general',
        component: () => import('@/pages/AdminGeneral.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/analytics',
        component: () => import('@/pages/AdminAnalytics.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/approvals',
        component: () => import('@/pages/AdminApprovals.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/blocks',
        component: () => import('@/pages/AdminBlocks.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/editors',
        component: () => import('@/pages/AdminEditors.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/glossary',
        component: () => import('@/pages/AdminGlossary.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/locale',
        component: () => import('@/pages/AdminLocale.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/login',
        component: () => import('@/pages/AdminLogin.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/navigation',
        component: () => import('@/pages/AdminNavigation.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/pages',
        component: () => import('@/pages/AdminPages.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/pages/deleted',
        component: () => import('@/pages/AdminPagesDeleted.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/storage/:id?',
        component: () => import('@/pages/AdminStorage.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/comments',
        component: () => import('@/pages/AdminComments.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/theme',
        component: () => import('@/pages/AdminTheme.vue'),
        meta: { siteScoped: true }
      },
      {
        path: ':siteid/ai',
        component: () => import('@/pages/AdminAi.vue'),
        meta: { siteScoped: true }
      },
      { path: 'auth', component: () => import('@/pages/AdminAuth.vue') },
      { path: 'groups/:id?/:section?', component: () => import('@/pages/AdminGroups.vue') },
      { path: 'users/:id?/:section?', component: () => import('@/pages/AdminUsers.vue') },
      { path: 'api', component: () => import('@/pages/AdminApi.vue') },
      { path: 'audit', component: () => import('@/pages/AdminAuditLog.vue') },
      { path: 'classification', component: () => import('@/pages/AdminClassification.vue') },
      { path: 'cluster', component: () => import('@/pages/AdminCluster.vue') },
      { path: 'extensions', component: () => import('@/pages/AdminExtensions.vue') },
      { path: 'icons', component: () => import('@/pages/AdminIcons.vue') },
      { path: 'livelog', component: () => import('@/pages/AdminLiveLog.vue') },
      { path: 'mail', component: () => import('@/pages/AdminMail.vue') },
      { path: 'metrics', component: () => import('@/pages/AdminMetrics.vue') },
      { path: 'pageviews', component: () => import('@/pages/AdminPageviews.vue') },
      { path: 'replication', component: () => import('@/pages/AdminReplication.vue') },
      { path: 'scheduler', component: () => import('@/pages/AdminScheduler.vue') },
      { path: 'search', component: () => import('@/pages/AdminSearch.vue') },
      { path: 'security', component: () => import('@/pages/AdminSecurity.vue') },
      { path: 'system', component: () => import('@/pages/AdminSystem.vue') },
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

  {
    path: '/_create/:editor?',
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  },
  {
    /*
      A custom regex rather than the `*` repeat modifier `/:catchAll(.*)*` uses below: `*` would turn
      the param into an array of segments, but `pagePath` is handed straight to `pageEdit({ path })`
      as a single string. The trailing `?` keeps a bare `/_edit` valid too.
    */
    path: '/_edit/:pagePath(.*)?',
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  },
  {
    path: '/:catchAll(.*)*',
    /*
      `meta.contentPage` marks the routes that render `Index.vue` and therefore run a page through
      `pageStore.pageLoad()` -- this one, `/_create` and `/_edit`. `MainLayout.vue`'s
      `effectiveNavigationId` reads the flag to decide whether `pageStore.navigationId` means
      anything: on any other route it is null or left over from a previously-viewed content page, so
      those routes fall back to the site's own default id.
    */
    meta: { contentPage: true },
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  }
]

export default routes
