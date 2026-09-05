<template>
  <w-layout class="admin">
    <w-header class="admin-header">
      <div class="flex flex-nowrap">
        <w-toolbar style="height: 64px">
          <w-btn dense flat to="/" :aria-label="t(`common.header.home`)">
            <w-avatar size="34px" square>
              <img src="/_assets/logo-wikijs.svg" alt="" />
            </w-avatar>
          </w-btn>
          <w-toolbar-title class="admin-wordmark">Wiki.js</w-toolbar-title>
        </w-toolbar>
        <w-toolbar class="max-md:hidden justify-center" style="height: 64px">
          <div class="admin-area-label">{{ t('admin.adminArea') }}</div>
          <w-badge class="ms-2" label="beta" color="accent" outline />
        </w-toolbar>
        <w-toolbar style="height: 64px">
          <w-space />
          <transition name="syncing">
            <w-spinner v-show="commonStore.routerLoading" color="accent" size="20px" />
          </transition>
          <!--
            Outlined rather than flat-on-a-black-bar: the admin header is a white plate now, so these
            two need an edge of their own to read as controls. Exit keeps the accent -- it is the one
            thing in the bar that leaves.
          -->
          <w-btn
            class="ms-2"
            outline
            icon="la:times-circle"
            :label="t(`common.actions.exit`)"
            color="accent"
            to="/" />
          <w-btn class="ms-2" outline icon="la:language" :label="commonStore.locale" color="slate">
            <!--
              Down from the button's trailing edge, like `PageHeader.vue`'s review-queue menu: `WMenu`
              places itself in raw viewport pixels and knows nothing about `direction`
              (`composables/anchoredPosition.js`), so the LTR-written "right" pair would pop the panel
              off toward the visual right even once `dir="rtl"` has moved this button (the last item in
              this toolbar's row) to the visual left. `localeMenu` mirrors it via `directionalAnchor`,
              kept reactive off `composables/direction.js` since this header, like `PageHeader.vue`'s,
              outlives a single locale -- it is this very menu that switches `commonStore.locale`, so a
              reader picking an RTL locale from it must see it flip on the next render, not only after a
              full reload.
            -->
            <w-menu
              content-class="translucent-menu"
              auto-close
              :anchor="localeMenu.anchor"
              :self="localeMenu.self">
              <w-list separator padding>
                <w-item
                  v-for="lang of adminStore.locales"
                  :key="lang.code"
                  clickable
                  @click="commonStore.setLocale(lang.code)">
                  <w-item-section side>
                    <w-avatar
                      rounded
                      :color="lang.code === commonStore.locale ? `secondary` : `primary`"
                      text-color="white"
                      size="sm">
                      <div class="text-caption uppercase">
                        <strong>{{ lang.language }}</strong>
                      </div>
                    </w-avatar>
                  </w-item-section>
                  <w-item-section>
                    <w-item-label>{{ lang.nativeName }}</w-item-label>
                    <w-item-label caption>{{ lang.name }}</w-item-label>
                  </w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <account-menu />
        </w-toolbar>
      </div>
    </w-header>
    <w-drawer class="admin-sidebar" v-model="leftDrawerOpen" bordered>
      <w-scroll-area class="admin-nav">
        <w-list class="admin-nav-list pb-6" padding dense dark>
          <w-item class="mb-2">
            <w-item-section>
              <w-btn
                outline
                color="accent-dark"
                icon="la:heart"
                :label="t(`admin.contribute.title`)"
                href="https://js.wiki/donate"
                target="_blank" />
            </w-item-section>
          </w-item>
          <w-item to="/_admin/dashboard" active-class="admin-nav-active">
            <w-item-section avatar>
              <w-icon name="cardinal:dashboard" />
            </w-item-section>
            <w-item-section>{{ t('admin.dashboard.title') }}</w-item-section>
          </w-item>
          <w-item
            to="/_admin/sites"
            active-class="admin-nav-active"
            v-if="userStore.can(`manage:sites`)">
            <w-item-section avatar>
              <w-icon name="cardinal:sites" />
            </w-item-section>
            <w-item-section>{{ t('admin.sites.title') }}</w-item-section>
            <w-item-section side>
              <w-badge
                color="dark-3"
                :label="adminStore.sites.length"
                :class="countBadgeClass(adminStore.sites.length)" />
            </w-item-section>
          </w-item>
          <template v-if="siteSectionShown">
            <w-item-label class="admin-nav-section" header>{{ t('admin.nav.site') }}</w-item-label>
            <w-item class="mb-2">
              <w-item-section>
                <w-select
                  dark
                  standout
                  dense
                  hide-bottom-space
                  v-model="adminStore.currentSiteId"
                  :options="adminStore.sites"
                  option-value="id"
                  option-label="title"
                  emit-value
                  map-options
                  :aria-label="t('admin.nav.site')" />
              </w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/general`"
              active-class="admin-nav-active"
              v-if="maySeeGeneral">
              <w-item-section avatar>
                <w-icon name="cardinal:general" />
              </w-item-section>
              <w-item-section>{{ t('admin.general.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/approvals`"
              active-class="admin-nav-active"
              v-if="maySeeApprovals">
              <w-item-section avatar>
                <w-icon name="cardinal:approvals" />
              </w-item-section>
              <w-item-section>{{ t('admin.approval.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/analytics`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:sites`)">
              <w-item-section avatar>
                <w-icon name="cardinal:analytics" />
              </w-item-section>
              <w-item-section>{{ t('admin.analytics.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/comments`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:sites`)">
              <w-item-section avatar>
                <w-icon name="cardinal:comments" />
              </w-item-section>
              <w-item-section>{{ t('admin.comments.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/blocks`"
              active-class="admin-nav-active"
              v-if="maySeeBlocks">
              <w-item-section avatar>
                <w-icon name="cardinal:blocks" />
              </w-item-section>
              <w-item-section>{{ t('admin.blocks.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/editors`"
              active-class="admin-nav-active"
              v-if="maySeeEditors">
              <w-item-section avatar>
                <w-icon name="cardinal:editors" />
              </w-item-section>
              <w-item-section>{{ t('admin.editors.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/glossary`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:glossary`)">
              <w-item-section avatar>
                <w-icon name="cardinal:glossary" />
              </w-item-section>
              <w-item-section>{{ t('admin.glossary.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/locale`"
              active-class="admin-nav-active"
              v-if="maySeeLocale">
              <w-item-section avatar>
                <w-icon name="cardinal:locale" />
              </w-item-section>
              <w-item-section>{{ t('admin.locale.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/login`"
              active-class="admin-nav-active"
              v-if="maySeeLogin">
              <w-item-section avatar>
                <w-icon name="cardinal:login" />
              </w-item-section>
              <w-item-section>{{ t('admin.login.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/navigation`"
              active-class="admin-nav-active"
              v-if="maySeeNavigation">
              <w-item-section avatar>
                <w-icon name="cardinal:navigation" />
              </w-item-section>
              <w-item-section>{{ t('admin.navigation.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/pages`"
              active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:pages" />
              </w-item-section>
              <w-item-section>{{ t('admin.pages.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/pages/deleted`"
              active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:pages-deleted" />
              </w-item-section>
              <w-item-section>{{ t('history.recovery.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/storage`"
              active-class="admin-nav-active"
              v-if="maySeeStorage">
              <w-item-section avatar>
                <w-icon name="cardinal:storage" />
              </w-item-section>
              <w-item-section>{{ t('admin.storage.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/theme`"
              active-class="admin-nav-active"
              v-if="maySeeTheme">
              <w-item-section avatar>
                <w-icon name="cardinal:theme" />
              </w-item-section>
              <w-item-section>{{ t('admin.theme.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="usersSectionShown">
            <w-item-label class="admin-nav-section" header>{{ t('admin.nav.users') }}</w-item-label>
            <w-item
              to="/_admin/auth"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="cardinal:authentication" />
              </w-item-section>
              <w-item-section>{{ t('admin.auth.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/groups" active-class="admin-nav-active" v-if="groupsAreVisible">
              <w-item-section avatar>
                <w-icon name="cardinal:groups" />
              </w-item-section>
              <w-item-section>{{ t('admin.groups.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.groupsTotal"
                  :class="countBadgeClass(adminStore.info.groupsTotal)" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/users" active-class="admin-nav-active" v-if="usersAreVisible">
              <w-item-section avatar>
                <w-icon name="cardinal:users" />
              </w-item-section>
              <w-item-section>{{ t('admin.users.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.usersTotal"
                  :class="countBadgeClass(adminStore.info.usersTotal)" />
              </w-item-section>
            </w-item>
          </template>
          <template v-if="userStore.can(`manage:system`)">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.system')
            }}</w-item-label>
            <w-item to="/_admin/api" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:api" />
              </w-item-section>
              <w-item-section>{{ t('admin.api.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.info.isApiEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/audit" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:audit-log" />
              </w-item-section>
              <w-item-section>{{ t('admin.audit.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/classification" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="la:layer-group" />
              </w-item-section>
              <w-item-section>{{ t('admin.classification.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/extensions" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:extensions" />
              </w-item-section>
              <w-item-section>{{ t('admin.extensions.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/icons" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:icons" />
              </w-item-section>
              <w-item-section>{{ t('admin.icons.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/cluster" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:cluster" />
              </w-item-section>
              <w-item-section>{{ t('admin.cluster.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.clusterTotal"
                  :class="countBadgeClass(adminStore.info.clusterTotal)" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/mail" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:mail" />
              </w-item-section>
              <w-item-section>{{ t('admin.mail.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isMailConfigured ? `positive` : `warning`"
                  :pulse="!adminStore.info.isMailConfigured" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/metrics" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:metrics" />
              </w-item-section>
              <w-item-section>{{ t('admin.metrics.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.info.isMetricsEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/pageviews" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:pageviews" />
              </w-item-section>
              <w-item-section>{{ t('admin.pageviews.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isPageviewsEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/replication" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:replication" />
              </w-item-section>
              <w-item-section>{{ t('admin.replication.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isReplicationEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/scheduler" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:scheduler" />
              </w-item-section>
              <w-item-section>{{ t('admin.scheduler.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isSchedulerHealthy ? `positive` : `warning`"
                  :pulse="!adminStore.info.isSchedulerHealthy" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/search" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:glossary" />
              </w-item-section>
              <w-item-section>{{ t('admin.search.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/security" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:security" />
              </w-item-section>
              <w-item-section>{{ t('admin.security.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/system" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:system-info" />
              </w-item-section>
              <w-item-section>{{ t('admin.system.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.isVersionLatest ? `positive` : `warning`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/terminal" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:terminal" />
              </w-item-section>
              <w-item-section>{{ t('admin.terminal.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/utilities" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:utilities" />
              </w-item-section>
              <w-item-section>{{ t('admin.utilities.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/webhooks" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:webhooks" />
              </w-item-section>
              <w-item-section>{{ t('admin.webhooks.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.webhooksTotal"
                  :class="countBadgeClass(adminStore.info.webhooksTotal)" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/flags" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="cardinal:feature-flags" />
              </w-item-section>
              <w-item-section>{{ t('admin.dev.flags.title') }}</w-item-section>
            </w-item>
          </template>
        </w-list>
      </w-scroll-area>
    </w-drawer>
    <!--
      The way back to the sidebar once it overlays the page instead of taking a column of its own, exactly
      as `MainLayout` offers one: nothing else in the admin area opens it, and the header is a row of site
      and account controls with no room for a menu button.

      The position goes on a wrapper rather than on the button, as `WPageScroller` does it: `WBtn` is
      `relative` from its own class list, and Tailwind emits `relative` after `fixed`, so a `fixed`
      alongside it loses. `.corner-btn` is in `css/_base.scss`, since this layout never loads MainLayout's
      stylesheet.

      `left-0` (not `start-0`) is deliberate, matching `MainLayout`'s own corner button -- OpenProject
      #1590's physical-positioning triage: a fixed screen corner, not a reading-direction gutter. See
      `frontend/src/physicalPositioning.test.js`.
    -->
    <transition name="corner-btn">
      <div v-if="showSidebarBtn" class="fixed bottom-0 left-0 z-30">
        <w-btn
          class="corner-btn corner-btn--left"
          icon="la:bars"
          color="primary"
          round
          size="md"
          :aria-label="t(`admin.adminArea`)"
          @click="narrowSidebarOpen = true" />
      </div>
    </transition>
    <w-page-container class="admin-container">
      <router-view v-slot="{ Component }"><component :is="Component" /></router-view>
      <w-footer><footer-nav generic /></w-footer>
    </w-page-container>
    <w-dialog
      class="admin-overlay"
      v-model="overlayIsShown"
      persistent
      full-width
      full-height
      :aria-label="overlayAriaLabel">
      <component :is="overlays[adminStore.overlay]" />
    </w-dialog>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { useMinWidth } from '@/composables/screen'
import { maySeeSiteSurface } from '@/composables/siteAdminAccess'
import { useDirection } from '@/composables/direction'
import { directionalAnchor } from '@/helpers/directionalAnchor'

import { useAdminStore } from '@/stores/admin'
import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import AccountMenu from '../components/AccountMenu.vue'
import FooterNav from '@/components/FooterNav.vue'
import LoadingGeneric from '@/components/LoadingGeneric.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'
// -> Each with a loading placeholder, as the overlays opened from the page view have: the dialog
//    around them is already on screen while the chunk is fetched, so without one the panel is empty
//    until it arrives and then fills in all at once
const overlays = {
  EditorMarkdownConfig: defineAsyncComponent({
    loader: () => import('../components/EditorMarkdownConfigOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  GroupEditOverlay: defineAsyncComponent({
    loader: () => import('../components/GroupEditOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  UserEditOverlay: defineAsyncComponent({
    loader: () => import('../components/UserEditOverlay.vue'),
    loadingComponent: LoadingGeneric
  })
}

// STORES

const adminStore = useAdminStore()
const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// META

// -> The site's own name rather than the literal `Wiki.js`, as the page view does. A getter, so the
//    template is recomputed when the site config arrives -- see the note in `MainLayout`.
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => `${title} - ${t('admin.adminArea')} - ${siteTitle}`
  }
})

// DATA

/**
 * Whether the reader has opened the overlaying sidebar. Only consulted below the breakpoint, where the
 * drawer is a panel over the page; above it the sidebar is a column that is simply there.
 */
const narrowSidebarOpen = ref(false)

// DIRECTION

const direction = useDirection()

// COMPUTED

/**
 * Where the drawer stops overlaying the page and takes its own column — `WDrawer`'s own default, which
 * this layout leaves alone (unlike the site sidebar, which asks for 1200).
 */
const isWideViewport = useMinWidth(1024)

/**
 * The header's own language-switcher menu's `anchor`/`self`, LTR-correct pair mirrored for
 * `dir="rtl"` — see the template comment above the `w-menu` this feeds.
 */
const localeMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'bottom right', 'top right')
)

/**
 * `overlays`' loaded child owns the only visible heading for this full-screen overlay (its own
 * `<w-header class="card-header">`), so the accessible name is looked up here rather than duplicated
 * as a prop threaded down -- each entry mirrors the exact translation key that child's own header
 * already renders (OpenProject #2356).
 */
const ADMIN_OVERLAY_TITLES = {
  EditorMarkdownConfig: () => t('admin.editors.markdownName'),
  GroupEditOverlay: () => t('admin.groups.edit'),
  UserEditOverlay: () => t('admin.users.edit')
}

const overlayAriaLabel = computed(() => ADMIN_OVERLAY_TITLES[adminStore.overlay]?.())

/**
 * Whether the sidebar is on screen: always on a wide viewport, and only once asked for on a narrow one.
 *
 * It used to be `ref(true)` plus `show-if-above`, which had two consequences. On a narrow window the
 * sidebar arrived open, over the page. And closing it there — the scrim is the only way — set the model to
 * false, which is what `WDrawer` takes as its cue to stop applying `showIfAbove` for good: widening the
 * window afterwards brought back neither the column nor any way to ask for it. Expressing the whole state
 * here means the answer is recomputed from the width every time rather than latched once.
 */
const leftDrawerOpen = computed({
  get: () => isWideViewport.value || narrowSidebarOpen.value,
  // -> Only ever reached from the scrim, which exists only while overlaying
  set: (val) => {
    narrowSidebarOpen.value = val
  }
})

/*
  Shown only where the sidebar is something to open, and not while it is already open — the scrim is what
  closes it then, and the button would be behind the panel in any case.
*/
const showSidebarBtn = computed(() => !isWideViewport.value && !narrowSidebarOpen.value)

/*
  Task #684: each site-scoped surface's own gate, mirroring the exact permission combo its
  `Admin*.vue` page and backend route require (see `composables/siteAdminAccess.js`'s
  `GLOBAL_FALLBACKS` for why these differ from one blanket `manage:sites` check). Storage stays
  `manage:system`-only, matching `api/storage.ts` -- see
  `docs/decisions/delegated-per-site-administration.md` §4 for why it is not delegable.
*/
const maySeeGeneral = computed(() =>
  maySeeSiteSurface(userStore, 'site:general', adminStore.currentSiteId)
)
const maySeeApprovals = computed(() =>
  maySeeSiteSurface(userStore, 'site:approvals', adminStore.currentSiteId)
)
const maySeeBlocks = computed(() =>
  maySeeSiteSurface(userStore, 'site:blocks', adminStore.currentSiteId)
)
const maySeeEditors = computed(() =>
  maySeeSiteSurface(userStore, 'site:editors', adminStore.currentSiteId)
)
const maySeeLocale = computed(() =>
  maySeeSiteSurface(userStore, 'site:locale', adminStore.currentSiteId)
)
const maySeeLogin = computed(() =>
  maySeeSiteSurface(userStore, 'site:login', adminStore.currentSiteId)
)
const maySeeNavigation = computed(() =>
  maySeeSiteSurface(userStore, 'site:navigation', adminStore.currentSiteId)
)
const maySeeStorage = computed(() => userStore.can('manage:system'))
const maySeeTheme = computed(() =>
  maySeeSiteSurface(userStore, 'site:theme', adminStore.currentSiteId)
)

/*
  Shown once ANY site-scoped surface is reachable, global or delegated -- a delegated administrator
  holding only `site:general` on the current site has none of the three group-wide permissions this
  used to check alone, and would otherwise never see the site picker at all.
*/
const siteSectionShown = computed(() => {
  return (
    maySeeGeneral.value ||
    maySeeApprovals.value ||
    maySeeBlocks.value ||
    maySeeEditors.value ||
    maySeeLocale.value ||
    maySeeLogin.value ||
    maySeeNavigation.value ||
    maySeeStorage.value ||
    maySeeTheme.value
  )
})
/*
  `read:*` grants the list and detail routes without the write ones (see `api/users/admin.ts` /
  `api/groups.ts`), so the nav entry has to open for it too -- otherwise the permission grants access
  to pages nothing links to.
*/
const groupsAreVisible = computed(() => {
  return userStore.can('read:groups') || userStore.can('manage:groups')
})
const usersAreVisible = computed(() => {
  return userStore.can('read:users') || userStore.can('manage:users')
})
const usersSectionShown = computed(() => {
  return groupsAreVisible.value || usersAreVisible.value
})
const overlayIsShown = computed(() => {
  return Boolean(adminStore.overlay)
})

// METHODS

/*
  The nav count badges carry a trailing-edge border saying whether the thing they count exists at
  all -- red at zero, green otherwise -- so a section that is empty reads as such without opening
  it. The colours are the status lights' own, so the two markers in the column say the same thing
  the same way; see the `.count-badge` rules for where they come from.
*/
function countBadgeClass(count) {
  return count > 0 ? 'count-badge count-badge--filled' : 'count-badge'
}

// WATCHERS

watch(
  () => route.path,
  async (newValue) => {
    /*
      Following a link out of the overlaying sidebar puts it away, since the section it leads to is behind
      it. On a wide viewport there is nothing to close and the flag is not consulted anyway.
    */
    narrowSidebarOpen.value = false
    if (!newValue.startsWith('/_admin')) {
      return
    }
    if (!userStore.can('access:admin')) {
      router.replace('/_error/unauthorized')
    }
  },
  { immediate: true }
)
watch(
  () => adminStore.sites,
  (newValue) => {
    if (adminStore.currentSiteId === null && newValue.length > 0) {
      adminStore.$patch({
        currentSiteId: siteStore.id
      })
    }
  }
)
watch(
  () => adminStore.currentSiteId,
  (newValue) => {
    if (newValue && route.params.siteid !== newValue) {
      router.push({ params: { siteid: newValue } })
    }
  }
)
/*
  Task #684: the sidebar's `maySee*` computeds (`site:general`, `site:theme`, ...) read
  `userStore.sitePermissions`, which is only ever valid for the site it was fetched for -- so it has
  to be refreshed here too, not only by `useSiteAdminAccess()` on whichever specific page happens to
  be mounted. `immediate: true` covers the very first site the sidebar renders for, same as the
  `access:admin` watcher above covers the first route.
*/
watch(
  () => adminStore.currentSiteId,
  (newValue) => {
    userStore.fetchSitePermissions(newValue)
  },
  { immediate: true }
)

// MOUNTED

onMounted(async () => {
  if (!userStore.can('access:admin')) {
    router.replace('/_error/unauthorized')
    return
  }

  adminStore.fetchLocales()
  adminStore.fetchClassificationLevels()
  await adminStore.fetchSites()
  if (route.params.siteid) {
    adminStore.$patch({
      currentSiteId: route.params.siteid
    })
  }
  adminStore.fetchInfo()
})
</script>

<style lang="scss">
@use 'sass:color';

/*
  The admin header: a white plate ruled off from the page, matching the site header. The black bar
  it replaces was the one place in the app that carried its own colour rather than the site's, and
  on Cardinal there is nothing left for it to contrast against.
*/
.admin-header {
  background-color: $surface;
  color: $ink;
  border-bottom: 1px solid $hairline;
}

.body--dark .admin-header {
  background-color: $dark-3;
  color: $text-dark;
  border-bottom-color: $hairline-dark;
}

/* -> The wordmark, set exactly as the site header sets its own */
.admin-wordmark {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* -> "Admin area", in Cardinal's chrome overline */
.admin-area-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: $text-caption;
  white-space: nowrap;
}

.body--dark .admin-area-label {
  color: $text-caption-dark;
}

.admin-nav {
  height: 100%;
}
/*
  The 64px icon beside an admin page's title. `font-size`, not `height`: these were raster `<img>`
  assets and are `WIcon`'s inline SVG now, which sizes from the font size. Drawn in the chrome tone
  and set in a square hairline plate -- the same masthead treatment `PageHeader.vue` gives a page's
  own icon, so an admin screen opens the way a content screen does.
*/
.admin-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  font-size: 34px;
  color: $slate-soft;
  border: 1px solid $hairline;
  background-color: $paper;
}

.body--dark .admin-icon {
  color: $slate-light;
  border-color: $hairline-dark;
  background-color: $dark-4;
}

/*
  The admin sidebar is drawn on INK in both themes -- it is the one column in the app that always is,
  and the design keeps it that way: a white header plate over a dark index, which is what tells you
  at a glance that you are behind the scenes rather than in the wiki.
*/
.admin-sidebar {
  background-color: $ink;
  border-inline-end: 1px solid $hairline-dark;

  @at-root .body--dark & {
    background-color: $dark-5;
  }

  .admin-nav-list {
    color: $slate-pale;
  }

  /*
    The current page: the raised tone with a 2px accent bar down its leading edge and its icon in the
    lightened accent -- the same "you are here" mark the site sidebar, the overlays' rails and the
    file list all use. It replaces a solid `bg-primary` fill, which on a red accent made the whole row
    shout louder than the page it points at.

    A border rather than a background stripe, so it takes its 2px out of the row's own inline padding
    -- which is why the padding is given back below.
  */
  .admin-nav-active {
    background-color: $dark-2;
    border-inline-start: 2px solid $accent-fill;
    color: #fff;
    font-weight: 500;

    .w-icon,
    iconify-icon {
      color: $accent-dark;
    }
  }

  /* -> Nav rows are a 24px icon and its label, so the avatar column's 56px track centres the icon
  //    and leaves the pair reading as two columns rather than one item. Sizing the column to the
  //    icon leaves the section's own 16px as the whole gap. Needs the extra `.w-list` to outrank
  //    WItemSection's scoped rule, which matches on specificity alone. */
  .w-list .w-item-section--avatar {
    min-width: auto;
  }

  /*
    Nav rows carry two kinds of trailing marker -- a status light and a count badge -- and they have
    to read as one column. Both already end on the same trailing edge (regression coverage for
    feature 413, task 727: StatusLight has no left/right of its own, only document order inside the
    row's flex layout, so it already follows the reader's direction for free -- .count-badge's own
    border below has to use the matching logical property, `border-inline-end`, or a `dir="rtl"`
    reader would see the two markers' accent colours point at opposite edges of the same row, same
    class of bug NavSidebar's open-group rail had). What did not line up is the height. StatusLight is
    `height: 100%`, so it takes whatever the row gives it (28px on these dense rows), while a badge is
    sized by its own text at 16px, leaving the lights standing 6px proud above and below every badge
    in the column.

    Pinning them to the badge's band fixes that. It is scoped to the sidebar rather than changed in
    StatusLight, because the full-height stripe is the point everywhere else it is used: the storage,
    rendering and auth lists put one beside a two-line item, where it reads as an edge marker for the
    whole row and has no badge to line up with.
  */
  .w-list .status-light {
    height: 16px;
  }

  /*
    `$negative-fill` / `$positive-fill` rather than the `--color-*` custom properties, because these
    have to match the status lights beside them exactly and StatusLight styles itself from the SCSS
    variables -- the custom properties resolve through `--q-*`, which is rewritten at runtime for
    per-site theming and would drift away from the lights on any site that sets its own colours. The
    FILL tone of each, for the same reason StatusLight uses it: nothing is drawn over these bars.
  */
  // -> 5px is StatusLight's own width, so the stripe on a badge and the light on the row below it
  //    are the same bar of colour rather than two thicknesses of it
  .count-badge {
    border-inline-end: 5px solid $negative-fill;

    &--filled {
      border-inline-end-color: $positive-fill;
    }
  }

  /* -> The section headings between nav groups, in Cardinal's chrome overline, with one hairline
  //    above them rather than the two-tone bevel the double box-shadow drew */
  .admin-nav-section,
  .w-item-label--header {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid $hairline-dark;
    color: $text-caption-dark;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
}

/*
  Every admin page's own title row, shared by all 37 of them rather than restated per page.

  Cardinal sets a page title in Barlow Condensed at 34/700 in INK -- the display face, at the size
  the masthead uses, and not in the brand colour: `text-h5 text-primary` made every admin screen open
  with a 24px red heading, which is the accent doing a heading's job. The accent is reserved for the
  live edge, and a page title is not one.

  Unscoped, in the admin layout's own stylesheet, because these classes are written in 37 page
  components and one declaration is what keeps them in step.
*/
.admin-page-title {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: normal;
  color: $ink;
}

.body--dark .admin-page-title {
  color: $text-dark;
}

.admin-page-subtitle {
  font-size: 14.5px;
  line-height: 1.45;
  letter-spacing: normal;
  color: $text-secondary;
}

.body--dark .admin-page-subtitle {
  color: $text-secondary-dark;
}

// -> No `.w-card` rule here: WCard already paints its own surface with these exact colours, and an
//    unlayered rule in an SFC stylesheet outranks every Tailwind utility however specific, so this
//    restatement did nothing except stop the admin pages tinting a card with `bg-negative` / `bg-info`
.admin-container {
  @at-root .body--light & {
    background-color: $paper;
  }
  @at-root .body--dark & {
    background-color: $dark-5;
  }
}

.admin-overlay {
  > .w-dialog-backdrop {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px) saturate(180%);
  }
  > .w-dialog-viewport {
    // -> Equal margins all round until 1600px, where the sides can afford to be wider. Same rule and
    //    same reasoning as `.main-overlay` in `MainLayout`, which the admin overlays match.
    padding: 24px;

    @media (min-width: 1600px) {
      padding: 24px 64px;
    }

    // -> Last of the three, so it still wins on a phone: all three have the same specificity
    @media (max-width: 1023.98px) {
      padding: 0;
    }

    // -> A flat panel with a hairline edge, matching `.main-overlay`'s; see MainLayout for why the
    //    gradient title strip both of them used to draw is gone
    > .w-dialog-panel {
      box-shadow: 0 10px 40px 0 rgba(28, 34, 51, 0.28);

      @at-root .body--light & {
        background-color: $paper;
        border: 1px solid $hairline;
      }
      @at-root .body--dark & {
        background-color: $dark-5;
        border: 1px solid $hairline-dark;
      }
    }
  }
}

// -> The `.admin-footer > .q-bar` rule that used to sit here never matched: FooterNav rendered a
//    footer element, never a bar. Its colours come from its own scoped style.
</style>
