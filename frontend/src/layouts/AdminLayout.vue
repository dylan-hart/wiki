<template>
  <w-layout class="admin">
    <w-header class="admin-header">
      <div class="flex flex-nowrap">
        <w-toolbar style="height: 64px">
          <w-btn
            class="flush-hover-btn header-nav-btn"
            flat
            to="/"
            :aria-label="t(`common.header.home`)">
            <w-avatar size="64px" square>
              <img src="/_assets/logo-cardinal.svg" alt="" />
            </w-avatar>
          </w-btn>
          <w-toolbar-title class="admin-wordmark">Cardinal</w-toolbar-title>
        </w-toolbar>
        <w-toolbar class="max-md:hidden justify-center" style="height: 64px">
          <div class="admin-area-label">{{ t('admin.adminArea') }}</div>
        </w-toolbar>
        <w-toolbar style="height: 64px">
          <w-space />
          <transition name="syncing">
            <w-spinner v-show="commonStore.routerLoading" color="accent" size="20px" />
          </transition>
          <!-- Outlined so they read as controls on the white header plate -->
          <w-btn
            class="ms-2 admin-header-action-btn"
            outline
            icon="tabler:circle-x"
            :label="t(`common.actions.exit`)"
            color="accent"
            to="/" />
          <w-btn
            class="ms-2 admin-header-action-btn"
            outline
            icon="tabler:language"
            :label="commonStore.locale.toUpperCase()"
            color="slate">
            <!--
              `WMenu` places itself in raw viewport pixels and knows nothing about `direction`, so
              the LTR-written "right" pair would pop the panel off toward the visual right once
              `dir="rtl"` has moved this button to the visual left. `localeMenu` mirrors it
              reactively: this menu is what switches the locale, so the flip has to happen on the
              next render rather than on a reload.
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
                      :color="lang.code === commonStore.locale ? `accent` : `slate`"
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
              <!--
                Border in the accent fill, label in the lightened accent: on the ink sidebar the
                text tone is too pale to bound a box, and the fill tone does not clear contrast as
                a label.
              -->
              <w-btn
                class="admin-contribute-btn"
                outline
                color="accent-dark"
                icon="tabler:heart"
                :label="t(`admin.contribute.title`)"
                href="https://github.com/dylan-hart/wiki"
                target="_blank" />
            </w-item-section>
          </w-item>
          <!--
            Overview carries no wrapping `v-if`: Dashboard and Contribute are reachable to anyone
            holding `access:admin`, which the route watcher below already enforces.
          -->
          <w-item-label class="admin-nav-section" header>{{
            t('admin.nav.overview')
          }}</w-item-label>
          <w-item to="/_admin/dashboard" active-class="admin-nav-active">
            <w-item-section avatar>
              <w-icon name="tabler:layout-dashboard" />
            </w-item-section>
            <w-item-section>{{ t('admin.dashboard.title') }}</w-item-section>
          </w-item>
          <w-item
            to="/_admin/sites"
            active-class="admin-nav-active"
            v-if="userStore.can(`manage:sites`)">
            <w-item-section avatar>
              <w-icon name="tabler:browser" />
            </w-item-section>
            <w-item-section>{{ t('admin.sites.title') }}</w-item-section>
            <w-item-section side>
              <w-badge
                color="dark-3"
                :label="adminStore.sites.length"
                :class="countBadgeClass(adminStore.sites.length)" />
            </w-item-section>
          </w-item>
          <template v-if="contentSectionShown">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.content')
            }}</w-item-label>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/pages`"
              active-class="admin-nav-active"
              v-if="siteSectionShown">
              <w-item-section avatar>
                <w-icon name="tabler:folder" />
              </w-item-section>
              <w-item-section>{{ t('admin.pages.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/pages/deleted`"
              active-class="admin-nav-active"
              v-if="siteSectionShown">
              <w-item-section avatar>
                <w-icon name="tabler:trash" />
              </w-item-section>
              <w-item-section>{{ t('admin.pages.deletedTitle') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/glossary`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:glossary`)">
              <w-item-section avatar>
                <w-icon name="tabler:list-search" />
              </w-item-section>
              <w-item-section>{{ t('admin.glossary.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/comments`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:sites`)">
              <w-item-section avatar>
                <w-icon name="tabler:message" />
              </w-item-section>
              <w-item-section>{{ t('admin.comments.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/approvals`"
              active-class="admin-nav-active"
              v-if="maySeeApprovals">
              <w-item-section avatar>
                <w-icon name="tabler:checkbox" />
              </w-item-section>
              <w-item-section>{{ t('admin.approval.title') }}</w-item-section>
            </w-item>
            <w-item
              to="/_admin/classification"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:stack-2" />
              </w-item-section>
              <w-item-section>{{ t('admin.classification.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="siteConfigurationShown">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.siteConfiguration')
            }}</w-item-label>
            <w-item class="mb-2">
              <w-item-section>
                <w-select
                  dark
                  standout
                  dense
                  hide-bottom-space
                  class="admin-site-select"
                  v-model="adminStore.currentSiteId"
                  :options="adminStore.sites"
                  option-value="id"
                  option-label="title"
                  emit-value
                  map-options
                  :aria-label="t('admin.nav.siteConfiguration')" />
              </w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/general`"
              active-class="admin-nav-active"
              v-if="maySeeGeneral">
              <w-item-section avatar>
                <w-icon name="tabler:world" />
              </w-item-section>
              <w-item-section>{{ t('admin.general.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/theme`"
              active-class="admin-nav-active"
              v-if="maySeeTheme">
              <w-item-section avatar>
                <w-icon name="tabler:layout-navbar" />
              </w-item-section>
              <w-item-section>{{ t('admin.theme.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/navigation`"
              active-class="admin-nav-active"
              v-if="maySeeNavigation">
              <w-item-section avatar>
                <w-icon name="tabler:sitemap" />
              </w-item-section>
              <w-item-section>{{ t('admin.navigation.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/locale`"
              active-class="admin-nav-active"
              v-if="maySeeLocale">
              <w-item-section avatar>
                <w-icon name="tabler:language" />
              </w-item-section>
              <w-item-section>{{ t('admin.locale.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/login`"
              active-class="admin-nav-active"
              v-if="maySeeLogin">
              <w-item-section avatar>
                <w-icon name="tabler:login" />
              </w-item-section>
              <w-item-section>{{ t('admin.login.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/storage`"
              active-class="admin-nav-active"
              v-if="maySeeStorage">
              <w-item-section avatar>
                <w-icon name="tabler:database" />
              </w-item-section>
              <w-item-section>{{ t('admin.storage.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="editingToolsShown">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.editingTools')
            }}</w-item-label>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/editors`"
              active-class="admin-nav-active"
              v-if="maySeeEditors">
              <w-item-section avatar>
                <w-icon name="tabler:writing" />
              </w-item-section>
              <w-item-section>{{ t('admin.editors.title') }}</w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/blocks`"
              active-class="admin-nav-active"
              v-if="maySeeBlocks">
              <w-item-section avatar>
                <w-icon name="tabler:components" />
              </w-item-section>
              <w-item-section>{{ t('admin.blocks.title') }}</w-item-section>
            </w-item>
            <w-item
              to="/_admin/search"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:list-search" />
              </w-item-section>
              <w-item-section>{{ t('admin.search.title') }}</w-item-section>
            </w-item>
            <w-item
              to="/_admin/icons"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:star" />
              </w-item-section>
              <w-item-section>{{ t('admin.icons.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="usersAccessShown">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.usersAccess')
            }}</w-item-label>
            <w-item
              to="/_admin/auth"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:lock-open" />
              </w-item-section>
              <w-item-section>{{ t('admin.auth.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/groups" active-class="admin-nav-active" v-if="groupsAreVisible">
              <w-item-section avatar>
                <w-icon name="tabler:users" />
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
                <w-icon name="tabler:user" />
              </w-item-section>
              <w-item-section>{{ t('admin.users.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.usersTotal"
                  :class="countBadgeClass(adminStore.info.usersTotal)" />
              </w-item-section>
            </w-item>
            <w-item
              to="/_admin/audit"
              active-class="admin-nav-active"
              v-if="userStore.can(`read:audit`)">
              <w-item-section avatar>
                <w-icon name="tabler:file-description" />
              </w-item-section>
              <w-item-section>{{ t('admin.audit.title') }}</w-item-section>
            </w-item>
            <w-item
              to="/_admin/security"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:shield" />
              </w-item-section>
              <w-item-section>{{ t('admin.security.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="userStore.can(`manage:system`)">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.monitoringHealth')
            }}</w-item-label>
            <w-item to="/_admin/system" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:cpu" />
              </w-item-section>
              <w-item-section>{{ t('admin.system.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.isVersionLatest ? `positive` : `warning`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/metrics" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:chart-bar" />
              </w-item-section>
              <w-item-section>{{ t('admin.metrics.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.info.isMetricsEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/pageviews" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:eye" />
              </w-item-section>
              <w-item-section>{{ t('admin.pageviews.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isPageviewsEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/livelog" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:terminal-2" />
              </w-item-section>
              <w-item-section>{{ t('admin.liveLog.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/cluster" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:binary-tree" />
              </w-item-section>
              <w-item-section>{{ t('admin.cluster.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.clusterTotal"
                  :class="countBadgeClass(adminStore.info.clusterTotal)" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/replication" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:refresh" />
              </w-item-section>
              <w-item-section>{{ t('admin.replication.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isReplicationEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item to="/_admin/scheduler" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:clock-play" />
              </w-item-section>
              <w-item-section>{{ t('admin.scheduler.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="adminStore.info.isSchedulerHealthy ? `positive` : `warning`"
                  :pulse="!adminStore.info.isSchedulerHealthy" />
              </w-item-section>
            </w-item>
          </template>
          <template v-if="integrationsAutomationShown">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.integrationsAutomation')
            }}</w-item-label>
            <w-item
              to="/_admin/api"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:api" />
              </w-item-section>
              <w-item-section>{{ t('admin.api.title') }}</w-item-section>
              <w-item-section side>
                <status-light :color="adminStore.info.isApiEnabled ? `positive` : `negative`" />
              </w-item-section>
            </w-item>
            <w-item
              to="/_admin/webhooks"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:bolt" />
              </w-item-section>
              <w-item-section>{{ t('admin.webhooks.title') }}</w-item-section>
              <w-item-section side>
                <w-badge
                  color="dark-3"
                  :label="adminStore.info.webhooksTotal"
                  :class="countBadgeClass(adminStore.info.webhooksTotal)" />
              </w-item-section>
            </w-item>
            <w-item
              to="/_admin/extensions"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:puzzle" />
              </w-item-section>
              <w-item-section>{{ t('admin.extensions.title') }}</w-item-section>
            </w-item>
            <w-item
              to="/_admin/mail"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:system`)">
              <w-item-section avatar>
                <w-icon name="tabler:mail" />
              </w-item-section>
              <w-item-section>{{ t('admin.mail.title') }}</w-item-section>
              <w-item-section side>
                <status-light
                  :color="isMailHealthy ? `positive` : `warning`"
                  :pulse="!isMailHealthy" />
              </w-item-section>
            </w-item>
            <w-item
              :to="`/_admin/` + adminStore.currentSiteId + `/analytics`"
              active-class="admin-nav-active"
              v-if="userStore.can(`manage:sites`)">
              <w-item-section avatar>
                <w-icon name="tabler:chart-line" />
              </w-item-section>
              <w-item-section>{{ t('admin.analytics.title') }}</w-item-section>
            </w-item>
          </template>
          <template v-if="userStore.can(`manage:system`)">
            <w-item-label class="admin-nav-section" header>{{
              t('admin.nav.securityAdvanced')
            }}</w-item-label>
            <w-item to="/_admin/flags" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:flag" />
              </w-item-section>
              <w-item-section>{{ t('admin.dev.flags.title') }}</w-item-section>
            </w-item>
            <w-item to="/_admin/utilities" active-class="admin-nav-active">
              <w-item-section avatar>
                <w-icon name="tabler:tool" />
              </w-item-section>
              <w-item-section>{{ t('admin.utilities.title') }}</w-item-section>
            </w-item>
          </template>
        </w-list>
      </w-scroll-area>
    </w-drawer>
    <!--
      The position goes on the wrapper, not on the button: `WBtn` is `relative` from its own class
      list and Tailwind emits `relative` after `fixed`, so a `fixed` alongside it loses.
      `.corner-btn` is in `css/_base.css`, since this layout never loads MainLayout's stylesheet.

      `left-0`, not `start-0`: a fixed screen corner, not a reading-direction gutter. See
      `frontend/src/physicalPositioning.test.js`.
    -->
    <transition name="corner-btn">
      <div v-if="showSidebarBtn" class="fixed bottom-0 left-0 z-30">
        <w-btn
          class="corner-btn corner-btn--left"
          icon="tabler:menu-2"
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
// -> A loading placeholder each: the dialog around them is already on screen while the chunk is
//    fetched, so without one the panel sits empty until it arrives and then fills in at once
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

const adminStore = useAdminStore()
const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

// -> A getter, not a plain object: the title is recomputed once the site config arrives.
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => `${title} - ${t('admin.adminArea')} - ${siteTitle}`
  }
})

const narrowSidebarOpen = ref(false)

const direction = useDirection()

/** 1024 mirrors `WDrawer`'s own `overlayBelow` default, which this layout leaves alone. */
const isWideViewport = useMinWidth(1024)

const localeMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'bottom right', 'top right')
)

/**
 * The loaded child owns the only visible heading for this full-screen overlay, so the accessible
 * name is looked up here rather than threaded down as a prop. Each entry mirrors the exact
 * translation key that child's own header renders -- keep the two maps in step.
 */
const ADMIN_OVERLAY_TITLES = {
  EditorMarkdownConfig: () => t('admin.editors.markdownName'),
  GroupEditOverlay: () => t('admin.groups.edit'),
  UserEditOverlay: () => t('admin.users.edit')
}

const overlayAriaLabel = computed(() => ADMIN_OVERLAY_TITLES[adminStore.overlay]?.())

/**
 * Recomputed from the width every time rather than a `ref` plus `show-if-above`: `WDrawer` stops
 * applying `showIfAbove` for good once its model is set false, so closing the overlaying sidebar on
 * a narrow window would leave a widened one with neither the column nor a way to ask for it.
 */
const leftDrawerOpen = computed({
  get: () => isWideViewport.value || narrowSidebarOpen.value,
  // -> Only ever reached from the scrim, which exists only while overlaying
  set: (val) => {
    narrowSidebarOpen.value = val
  }
})

const showSidebarBtn = computed(() => !isWideViewport.value && !narrowSidebarOpen.value)

/*
  Each gate mirrors the permission combo its `Admin*.vue` page and backend route require -- see
  `composables/siteAdminAccess.js`'s `GLOBAL_FALLBACKS` for why these differ from one blanket
  `manage:sites` check. Storage is `manage:system`-only because `api/storage.ts` is deliberately
  not delegable.
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

// -> Either half alone means a real user could be mailed something broken: an unreachable SMTP
//    transport, or mail links pointing at a host that does not resolve.
const isMailHealthy = computed(
  () => adminStore.info.isMailConfigured && adminStore.info.isMailBaseURLConfigured
)

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

const contentSectionShown = computed(() => {
  return (
    siteSectionShown.value ||
    userStore.can('manage:glossary') ||
    userStore.can('manage:sites') ||
    userStore.can('manage:system')
  )
})

const siteConfigurationShown = computed(() => {
  return (
    maySeeGeneral.value ||
    maySeeTheme.value ||
    maySeeNavigation.value ||
    maySeeLocale.value ||
    maySeeLogin.value ||
    maySeeStorage.value
  )
})

const editingToolsShown = computed(() => {
  return maySeeEditors.value || maySeeBlocks.value || userStore.can('manage:system')
})

/*
  `read:groups`/`read:users` grant the list and detail routes without the write ones, so the nav
  entry has to open for them too -- otherwise the permission reaches pages nothing links to.
*/
const groupsAreVisible = computed(() => {
  return userStore.can('read:groups') || userStore.can('manage:groups')
})
const usersAreVisible = computed(() => {
  return userStore.can('read:users') || userStore.can('manage:users')
})
const usersAccessShown = computed(() => {
  return (
    groupsAreVisible.value ||
    usersAreVisible.value ||
    userStore.can('read:audit') ||
    userStore.can('manage:system')
  )
})

const integrationsAutomationShown = computed(() => {
  return userStore.can('manage:system') || userStore.can('manage:sites')
})

const overlayIsShown = computed(() => {
  return Boolean(adminStore.overlay)
})

/*
  The badge's trailing-edge border is red at zero and green otherwise, so an empty section reads as
  empty without opening it. The tones are the status lights' own, so both markers in the column say
  the same thing the same way.
*/
function countBadgeClass(count) {
  return count > 0 ? 'count-badge count-badge--filled' : 'count-badge'
}

watch(
  () => route.path,
  async (newValue) => {
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
  `userStore.sitePermissions` is only ever valid for the site it was fetched for, and the sidebar's
  `maySee*` computeds read it -- so it is refreshed here too, not only by `useSiteAdminAccess()` on
  whichever page happens to be mounted. `immediate: true` covers the first site the sidebar renders.
*/
watch(
  () => adminStore.currentSiteId,
  (newValue) => {
    userStore.fetchSitePermissions(newValue)
  },
  { immediate: true }
)

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

<style>
.admin-header {
  background-color: var(--color-surface);
  color: var(--color-ink);
  border-bottom: 1px solid var(--color-hairline);
}

.body--dark .admin-header {
  background-color: var(--color-dark-3);
  color: var(--color-text-dark);
  border-bottom-color: var(--color-hairline-dark);
}

.admin-wordmark {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/*
  The custom property rather than a fixed tone: it is what lets a Cobalt site's own accent reach
  this border at all. `!important` beats WBtn's fixed border class.
*/
.admin-contribute-btn {
  border-color: var(--color-accent-fill) !important;
}

.admin-area-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--color-text-caption);
  white-space: nowrap;
}

.body--dark .admin-area-label {
  color: var(--color-text-caption-dark);
}

.admin-nav {
  height: 100%;
}
.admin-page-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--color-hairline);
  background-color: var(--color-surface);
}

.body--dark .admin-page-header {
  border-bottom-color: var(--color-hairline-dark);
  background-color: var(--color-dark-3);
}

/*
  The glyph is drawn well inside this box rather than filling it: the overhanging corner marks are
  what the eye reads as the frame, and a glyph run to the edges leaves them nothing to overhang.
*/
.admin-page-icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-control);
  background-color: var(--color-paper);
}

.body--dark:not(.body--cobalt) .admin-page-icon {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
}

/*
  One rule covers both modes: `--color-tint` and `--color-accent-strong` already carry Cobalt's
  light and dark values.
*/
body.body--cobalt .admin-page-icon {
  border-color: transparent;
  background-color: var(--color-tint);

  .admin-icon {
    color: var(--color-accent-strong);
  }
}

/*
  Background gradients rather than borders: a border draws a full side, and the design draws 7px of
  each corner and nothing between them.
*/
.admin-page-icon__marks {
  /* -> `block` in Ledger (a no-op), `none` in Cobalt, whose plate is bounded by its own radius */
  display: var(--corner-marks);
  position: absolute;
  inset: -5px;
  pointer-events: none;
  background:
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 0 / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 0 / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 0 / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 0 / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 100% / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 100% / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 100% / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 100% / 1px 7px no-repeat;
}

.admin-icon {
  flex: none;
  color: var(--color-slate-soft);
}

.body--dark .admin-icon {
  color: var(--color-slate-light);
}

/*
  The one accent-coloured thing in the band: it is what says which part of the admin area the reader
  is standing in. The title beneath it stays ink, like every other page title in the app.
*/
.admin-page-eyebrow {
  padding-bottom: 8px;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.body--dark .admin-page-eyebrow {
  color: var(--color-accent-dark);
}

/*
  Drawn on INK in both themes, deliberately: a dark index under a white header plate is what says at
  a glance that you are behind the scenes rather than in the wiki.
*/
.admin-sidebar {
  background-color: var(--color-ink);
  border-inline-end: 1px solid var(--color-hairline-dark);

  .body--dark & {
    background-color: var(--color-dark-5);
  }

  /*
    Stated here rather than left to WItem's own defaults, which size these rows off the app's body
    scale and draw them a step larger than the sidebar they sit in. Weight 300 is deliberate -- the
    one place Barlow sans drops below 600; the typography audit's removal rule is scoped to Barlow
    CONDENSED, so this sans-family row is not the violation it looks like. Metric, not colour, so
    both aesthetics share it and Cobalt's block below re-points only the colour.
  */
  .admin-nav-list {
    color: var(--color-slate-pale);
    font-size: 16px;
    font-weight: 300;

    .w-item {
      min-height: 0;
      padding-block: 7px;
    }

    .w-icon,
    iconify-icon {
      font-size: 16px;
      color: var(--color-slate-nav-icon);
    }
  }

  /*
    The same "you are here" mark the site sidebar, the overlays' rails and the file list all use --
    not a solid fill, which on a red accent makes the whole row shout louder than the page it points
    at.
  */
  .admin-nav-active {
    background-color: var(--color-dark-2);
    border-inline-start: 2px solid var(--color-accent-fill);
    color: #fff;
    font-weight: 500;

    .w-icon,
    iconify-icon {
      color: var(--color-accent-dark);
    }
  }

  /* -> The extra `.w-list` outranks WItemSection's scoped rule, matching on specificity alone */
  .w-list .w-item-section--avatar {
    min-width: auto;
  }

  /*
    StatusLight is `height: 100%`, so it takes the whole 28px row while a badge is sized by its own
    16px text -- leaving the lights standing proud of every badge in the same column. Scoped to the
    sidebar rather than changed in StatusLight, where the full-height stripe is the point: the
    storage, rendering and auth lists put one beside a two-line item with no badge to line up with.
  */
  .w-list .status-light {
    height: 16px;
  }

  /*
    The FILL tones, so these bars match the status lights beside them exactly -- both markers in the
    column have to read as one thing. 5px is StatusLight's own width, so a badge's stripe and the
    light on the row below it are one bar of colour rather than two thicknesses of it. The logical
    inline-end edge, or an RTL reader sees the two markers point at opposite sides of the same row.
  */
  .count-badge {
    border-inline-end: 5px solid var(--color-negative-fill);

    &--filled {
      border-inline-end-color: var(--color-positive-fill);
    }
  }

  .admin-nav-section,
  .w-item-label--header {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--color-hairline-dark);
    color: var(--color-text-caption-dark);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
}

/*
  Scoped to `body.body--cobalt` rather than folded into the rules above, for two reasons specific to
  this layout:

  1. The admin sidebar's Cobalt tokens (`--color-admin-sidebar-*`) are ALSO declared at `:root` with
     generic Ledger-ish defaults that do not reproduce this file's own hand-tuned Ledger values
     above -- consuming them unscoped would quietly shift Ledger's sidebar tone.
  2. `--q-header` and `--color-accent` are the SITE's own admin-editable brand colours. Reading them
     unscoped would make the admin header and page eyebrow follow a Ledger site's custom colours,
     which they never have -- `.admin-header` and `.admin-page-eyebrow` above are deliberately fixed
     regardless of `--q-*`.
*/
body.body--cobalt {
  .admin-header {
    background-color: var(--q-header);
    color: var(--color-white);
    border-bottom-color: transparent;
  }

  /*
    A literal, not a token: `--color-header-eyebrow` (#dfe6ff) is the SITE header's eyebrow, a
    different role with a different value, and no custom property carries #e6ecff for this one.
  */
  .admin-area-label {
    color: #e6ecff;
  }

  /*
    An outline WBtn's `color` prop only sets the inline text/icon colour -- the border is always the
    fixed `border-hairline dark:border-border-dark` Tailwind class, which reads poorly against this
    solid blue banner. `!important` is needed to beat that class and the button's own inline `color`
    style; `color: #fff` also recolours each icon, drawn in `currentColor`. Plain white needs no
    light/dark split, unlike the sidebar tokens below.
  */
  .admin-header-action-btn {
    border-color: #fff !important;
    color: #fff !important;
  }

  .admin-page-eyebrow {
    color: var(--color-accent);
  }

  .admin-sidebar {
    background-color: var(--color-admin-sidebar-bg);
    border-inline-end-color: var(--color-admin-sidebar-hairline);

    .admin-nav-list {
      color: var(--color-admin-sidebar-text);

      .w-icon,
      iconify-icon {
        color: var(--color-admin-sidebar-icon);
      }
    }

    .admin-nav-active {
      background-color: var(--color-admin-sidebar-raised);
      border-inline-start-color: var(--color-accent-fill);

      .w-icon,
      iconify-icon {
        color: var(--color-accent-fill);
      }
    }

    .admin-nav-section,
    .w-item-label--header {
      border-top-color: var(--color-admin-sidebar-hairline);
      color: var(--color-sidebar-kicker);
    }

    /*
      `w-badge` sets its background/text as an inline `:style`, which only an `!important` class
      rule can beat. The trailing-edge stripe is deliberately left alone: it has to keep matching
      `StatusLight`, which stays on its own fixed tones regardless of aesthetic.
    */
    .count-badge {
      background-color: var(--color-admin-sidebar-raised) !important;
      color: var(--color-sidebar-text-secondary) !important;
    }

    /*
      `!important` beats `dense`'s fixed Tailwind sizing and `standout`'s `bg-white/10` fill, neither
      of which varies for Cobalt. `--color-dark-4` reads as a darker interior than the sidebar behind
      it and `--color-heading-h2` as a clearly lighter blue border against it -- chosen in the
      absence of a mockup value for this control. Both tokens already cascade per mode, so one rule
      covers light and dark.
    */
    .admin-site-select .w-input-control {
      min-height: 38px !important;
      padding-inline: 14px !important;
      background-color: var(--color-dark-4) !important;
      border: 1px solid var(--color-heading-h2);
    }
  }
}

/*
  The page eyebrow is the one piece of this layout that already varies with `.body--dark`, so its
  Cobalt override needs the compound selector rather than living in the block above.
*/
body.body--cobalt.body--dark {
  .admin-page-eyebrow {
    color: var(--color-accent-dark);
  }
}

/*
  Ink, not the brand colour: the accent is reserved for the live edge, and a page title is not one.
  Unscoped here rather than restated per page, because every admin page component writes this class
  and one declaration is what keeps them in step.
*/
.admin-page-title {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: normal;
  color: var(--color-ink);
}

.body--dark .admin-page-title {
  color: var(--color-text-dark);
}

.admin-page-subtitle {
  margin-top: 4px;
  font-size: 14.5px;
  line-height: 1.45;
  letter-spacing: normal;
  color: var(--color-text-secondary);
}

.body--dark .admin-page-subtitle {
  color: var(--color-text-secondary-dark);
}

/* -> No `.w-card` rule here: an unlayered rule in an SFC stylesheet outranks every Tailwind */
/*    utility however specific, so one would stop admin pages tinting a card with `bg-negative` */
.admin-container {
  .body--light & {
    background-color: var(--color-paper);
  }
  .body--dark & {
    background-color: var(--color-dark-5);
  }
}

.admin-overlay {
  > .w-dialog-backdrop {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px) saturate(180%);
  }
  > .w-dialog-viewport {
    /* -> Same rule and reasoning as `.main-overlay` in `css/_overlay-dialog.css`, which the admin */
    /*    overlays match -- keep the two in step */
    padding: 24px;

    @media (min-width: 1600px) {
      padding: 24px 64px;
    }

    /* -> Last of the three, so it still wins on a phone: all three have the same specificity */
    @media (max-width: 1023.98px) {
      padding: 0;
    }

    > .w-dialog-panel {
      box-shadow: 0 10px 40px 0 rgba(28, 34, 51, 0.28);

      .body--light & {
        background-color: var(--color-paper);
        border: 1px solid var(--color-hairline);
      }
      .body--dark & {
        background-color: var(--color-dark-5);
        border: 1px solid var(--color-hairline-dark);
      }
    }
  }
}
</style>
