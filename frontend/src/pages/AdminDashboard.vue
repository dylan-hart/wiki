<template>
  <w-page class="admin-dashboard">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:layout-dashboard" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.dashboard.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.dashboard.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <div class="admin-dashboard-grid">
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:browser" />
          <div>
            <strong>{{ t('admin.sites.title') }}</strong>
            <span>{{ adminStore.sites.length }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:plus"
            :label="t(`common.actions.new`)"
            :disabled="!userStore.can(`manage:sites`)"
            @click="newSite" />
          <w-separator vertical />
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:sitemap"
            :label="t(`common.actions.manage`)"
            :disabled="!userStore.can(`manage:sites`)"
            to="/_admin/sites" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:users" />
          <div>
            <strong>{{ t('admin.groups.title') }}</strong>
            <span>{{ adminStore.info.groupsTotal }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:plus"
            :label="t(`common.actions.new`)"
            :disabled="!userStore.can(`manage:groups`)"
            @click="newGroup" />
          <w-separator vertical />
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:users"
            :label="t(`common.actions.manage`)"
            :disabled="!groupsAreVisible"
            to="/_admin/groups" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:user" />
          <div>
            <strong>{{ t('admin.users.title') }}</strong>
            <span>{{ adminStore.info.usersTotal }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:user-plus"
            :label="t(`common.actions.new`)"
            :disabled="!userStore.can(`manage:users`)"
            @click="newUser" />
          <w-separator vertical />
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:users"
            :label="t(`common.actions.manage`)"
            :disabled="!usersAreVisible"
            to="/_admin/users" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:folder" />
          <div>
            <strong>{{ t('admin.pages.title') }}</strong>
            <span>{{ adminStore.info.pagesTotal }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:sitemap"
            :label="t(`common.actions.view`)"
            :to="`/_admin/` + adminStore.currentSiteId + `/pages`" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:eye" />
          <div>
            <strong>{{ t(`admin.dashboard.logins`) }}</strong>
            <small
              >{{ adminStore.info.loginsPastDay }} <i>{{ t(`admin.dashboard.pastDay`) }}</i></small
            >
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:chart-area"
            :label="t(`admin.analytics.title`)"
            :disabled="!userStore.can(`manage:sites`)"
            :to="`/_admin/` + adminStore.currentSiteId + `/analytics`" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon :name="versionCard.icon" :color="versionCard.color" />
          <div>
            <strong>{{ t(`admin.dashboard.wikiVersion`) }}</strong>
            <small
              class="admin-dashboard-status"
              :class="{
                pending: versionCard.pending,
                'admin-dashboard-status--positive': versionCard.color === `positive`
              }"
              >{{ versionCard.status }}
              <i v-if="versionCard.version"
                >({{ versionCard.version
                }}<w-icon
                  v-if="versionCard.latestVersion"
                  name="tabler:arrow-right"
                  class="mx-1 align-middle" />{{ versionCard.latestVersion }})</i
              ></small
            >
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:refresh"
            :label="t(`admin.system.checkForUpdates`)"
            :disabled="!userStore.can(`manage:system`)"
            @click="checkForUpdates" />
          <w-separator vertical />
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:info-circle"
            :label="t(`admin.system.title`)"
            :disabled="!userStore.can(`manage:system`)"
            to="/_admin/system" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:robot" />
          <div>
            <strong>{{ t('admin.dashboard.activeWorkers') }}</strong>
            <span>{{ adminStore.info.activeWorkers }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:list-check"
            :label="t(`admin.scheduler.title`)"
            :disabled="!userStore.can(`manage:system`)"
            to="/_admin/scheduler" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:binary-tree" />
          <div>
            <strong>{{ t('admin.cluster.title') }}</strong>
            <span>{{ adminStore.info.clusterTotal }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:server"
            :label="t(`common.actions.view`)"
            :disabled="!userStore.can(`manage:system`)"
            to="/_admin/cluster" />
        </w-card-actions>
      </w-card>
      <w-card>
        <w-card-section class="admin-dashboard-card">
          <w-icon name="tabler:bolt" />
          <div>
            <strong>{{ t('admin.webhooks.title') }}</strong>
            <span>{{ adminStore.info.webhooksTotal }}</span>
          </div>
        </w-card-section>
        <w-separator />
        <w-card-actions align="right">
          <w-btn
            flat
            :color="actionColor"
            icon="tabler:bolt"
            :label="t(`common.actions.manage`)"
            :disabled="!userStore.can(`manage:system`)"
            to="/_admin/webhooks" />
        </w-card-actions>
      </w-card>
      <w-card class="admin-dashboard-logins">
        <div class="admin-dashboard-panel">
          <w-icon name="tabler:key" />
          <span>{{ t('admin.dashboard.lastLogins') }}</span>
        </div>
        <w-list separator>
          <!--
            Rows link only where the user list is reachable: this panel is `access:admin`, but
            reading one account needs `read:users`, so otherwise the link lands on a refusal.
          -->
          <w-item
            v-for="lastLogin of state.lastLogins"
            :key="lastLogin.id"
            :clickable="usersAreVisible"
            :to="usersAreVisible ? `/_admin/users/` + lastLogin.id : null">
            <w-item-section side>
              <w-icon name="tabler:user" :color="actionColor" />
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ lastLogin.name }}</w-item-label>
              <w-item-label caption>{{ lastLogin.email }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <div class="text-caption">{{ relativeDate(lastLogin.lastLoginAt) }}</div>
              <w-tooltip anchor="center left" self="center right">
                {{ userStore.formatDateTime(t, lastLogin.lastLoginAt) }}
              </w-tooltip>
            </w-item-section>
          </w-item>
          <w-item v-if="state.lastLogins.length < 1">
            <w-item-section>
              <w-item-label caption>{{ t('admin.dashboard.lastLoginsNone') }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { computed, onMounted, reactive } from 'vue'

import { useMeta } from '@/composables/meta'
import { dialog } from '@/composables/dialog'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { relativeDate } from '@/helpers/datetime'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { useAdminStore } from '../stores/admin'
import CheckUpdateDialog from '@/components/CheckUpdateDialog.vue'
import SiteCreateDialog from '@/components/SiteCreateDialog.vue'
import UserCreateDialog from '@/components/UserCreateDialog.vue'
import GroupCreateDialog from '@/components/GroupCreateDialog.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const dark = useDark()

/*
  `WBtn` emits its colour as an inline style, so no `dark:` class can reach it and the theme has to
  be read here: `slate` is picked to read on white, and the dark card needs the lightened one.
*/
const actionColor = computed(() => (dark.isActive ? 'slate-light' : 'slate'))

/* Opening the list only needs `read:*`; creating one is what needs `manage:*`. */
const groupsAreVisible = computed(
  () => userStore.can('read:groups') || userStore.can('manage:groups')
)
const usersAreVisible = computed(() => userStore.can('read:users') || userStore.can('manage:users'))

const router = useRouter()

const { t } = useI18n()

const state = reactive({
  loading: 0,
  lastLogins: []
})

const versionCard = computed(() => {
  switch (adminStore.versionStatus) {
    case 'latest':
      return {
        icon: 'tabler:checkbox',
        color: 'positive',
        status: t('admin.dashboard.versionUpToDate'),
        version: adminStore.info.currentVersion,
        latestVersion: null,
        pending: false
      }
    case 'outdated':
      return {
        icon: 'tabler:refresh-alert',
        color: 'warning-fill',
        status: t('admin.dashboard.versionUpdateAvailable'),
        version: adminStore.info.currentVersion,
        latestVersion: adminStore.info.latestVersion,
        pending: false
      }
    default:
      return {
        icon: 'tabler:refresh',
        color: 'slate-soft',
        status: t('admin.dashboard.versionChecking'),
        version: null,
        latestVersion: null,
        pending: true
      }
  }
})

useMeta(() => ({
  title: t('admin.dashboard.title')
}))

// -> Reports its own failure rather than throwing: one panel that could not be filled is not the
//    whole dashboard failing to refresh
async function loadLastLogins() {
  try {
    state.lastLogins = await API_CLIENT.get('users/recent-logins').json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`admin.dashboard.lastLoginsLoadFailed`),
      caption: apiErrorMessage(err)
    })
  }
}

async function load() {
  state.loading++
  try {
    await Promise.all([adminStore.fetchInfo(), adminStore.fetchSites(), loadLastLogins()])
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`admin.dashboard.refreshFailed`),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

// -> `AdminLayout` already fills the store for the counters; these rows are this page's alone, so
//    they are fetched here rather than on every admin screen
onMounted(loadLastLogins)

function newSite() {
  dialog({
    component: SiteCreateDialog
  }).onOk(() => {
    router.push('/_admin/sites')
  })
}
function newUser() {
  dialog({
    component: UserCreateDialog
  }).onOk(() => {
    router.push('/_admin/users')
  })
}
function newGroup() {
  dialog({
    component: GroupCreateDialog
  }).onOk(() => {
    router.push('/_admin/groups')
  })
}
function checkForUpdates() {
  dialog({
    component: CheckUpdateDialog
  })
}
</script>

<style>
/* Selectors stay flat: `&-suffix` concatenation is a Sass idiom, not valid in native CSS
   nesting -- the browser silently drops such a rule rather than reporting it. */
@charset "UTF-8";
.admin-dashboard {
  /* As many 230px cards as fit; the 24px inset lines up with the full-bleed header band above. */
}
.admin-dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
  padding: 20px 24px 40px;
  /*
    The card IS the grid item -- no wrapper between them, so grid's `align-items: stretch` grows the
    card itself rather than a wrapper around a card that stays short. The card is then a column
    whose figure band absorbs the slack, keeping the footer strip welded to the bottom edge.
  */
}
.admin-dashboard-grid > .w-card {
  display: flex;
  flex-direction: column;
}
.admin-dashboard-grid > .w-card > .admin-dashboard-card {
  flex: 1;
}
.admin-dashboard {
  /*
    A reading panel, not a counter: capped so its lines keep a readable measure instead of
    stretching to the window, and spanning the grid so it starts on a row of its own.
  */
}
.admin-dashboard-logins {
  grid-column: 1/-1;
  max-width: 640px;
  margin-top: 12px;
}
.admin-dashboard {
  /* -> The logins panel's head, banded so it does not read as a first list row */
}
.admin-dashboard-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-hairline);
  background-color: var(--color-tint);
  color: var(--color-slate);
}
.body--dark .admin-dashboard-panel {
  border-bottom-color: var(--color-hairline-dark);
  background-color: var(--color-dark-2);
  color: var(--color-slate-light);
}
.admin-dashboard-panel {
  /* `.w-icon`, not `img`: `WIcon` draws inline SVG and sizes from font-size, not width. */
}
.admin-dashboard-panel > .w-icon {
  font-size: 20px;
  flex: none;
}
.admin-dashboard-panel > span {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.admin-dashboard-card {
  display: flex;
  align-items: center;
  /* -> Sized by font-size, which is what `WIcon` scales from */
}
.admin-dashboard-card > .w-icon {
  font-size: 34px;
  margin-inline-end: 14px;
  color: var(--color-slate-soft);
  flex: none;
}
.admin-dashboard-card strong {
  font-size: 16px;
  font-weight: 300;
  display: block;
  line-height: 1.2;
  color: var(--color-slate);
  padding-inline-start: 2px;
}
.body--dark .admin-dashboard-card strong {
  color: var(--color-text-secondary-dark);
}
.admin-dashboard-card {
  /* The one place the accent is a number rather than an action: the figure is the card. */
}
.admin-dashboard-card span {
  font-family: var(--font-display);
  font-size: 30px;
  line-height: 1.1;
  font-weight: 700;
  color: var(--color-accent);
  display: block;
}
.admin-dashboard-card {
  /* The Logins figure, smaller because "N / past 24h" does not fit the plain `span` track. */
}
.admin-dashboard-card small {
  font-family: var(--font-display);
  font-size: 26px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-accent);
  display: block;
  /*
    The annotation riding along a figure ("/ past 24h", the version parenthetical) takes the app's
    caption tone rather than a scaled-down echo of the figure's own display face.
  */
}
.admin-dashboard-card small i {
  font-family: var(--font-mono);
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  color: var(--color-text-caption);
}
.admin-dashboard-card small {
  /*
    A status phrase, never a numeral, though it shares the `<small>` markup with the figure above:
    the extra class is what tells the two apart, out-specifying it regardless of source order.
  */
}
.admin-dashboard-card small.admin-dashboard-status {
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.4;
  font-weight: 500;
}
.admin-dashboard-card small {
  /*
    Only the up-to-date state has a specified colour; the other two keep the inherited accent, or
    the `.pending` amber below.
  */
}
.admin-dashboard-card small.admin-dashboard-status--positive {
  color: var(--color-positive);
}
.admin-dashboard-card small {
  /*
    Amber is picked to read on the dark surface and lands around 1.7:1 on the white card, so the
    light theme takes the darker end of the ramp instead.
  */
}
.admin-dashboard-card small.pending {
  color: var(--color-amber-9);
}
.body--dark .admin-dashboard-card small.pending {
  color: var(--color-amber);
}
.admin-dashboard {
  /* Flat and ruled off from the figure above: a gradient here reads as a shadow under the card. */
}
.admin-dashboard .w-card-actions {
  padding: 0;
  border-top: 1px solid var(--color-hairline);
  background-color: var(--color-paper);
}
.body--dark .admin-dashboard .w-card-actions {
  border-top-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
}
.admin-dashboard .w-card-actions .w-btn {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
}
</style>
