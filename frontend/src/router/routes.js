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
    path: '/_inbox',
    component: () => import('@/layouts/InboxLayout.vue'),
    children: [
      { path: '', redirect: '/_inbox/watching' },
      { path: 'watching', component: () => import('@/pages/InboxWatching.vue') },
      /*
        The submission being reviewed is in the URL, so a review can be linked to -- which is what a
        notification about one will have to do. Optional, since the same screen without it is the
        queue.
      */
      { path: 'review/:submissionId?', component: () => import('@/pages/InboxReview.vue') }
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
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  },
  // -----------------------
  // STANDARD PAGE CATCH-ALL
  // -----------------------
  {
    path: '/:catchAll(.*)*',
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Index.vue') }]
  }
]

export default routes
