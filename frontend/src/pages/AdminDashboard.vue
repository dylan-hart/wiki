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
    <!--
      An auto-fit track of 230px cards, which is what the design draws: a 12-column split
      stretched each card to a quarter of the window, so on a wide screen eight counters sat in
      eight very wide boxes with a number floating in the middle of each.
    -->
    <div class="admin-dashboard-grid">
      <div>
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
      </div>
      <div>
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
      </div>
      <div>
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
      </div>
      <div>
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
      </div>
      <div>
        <w-card>
          <w-card-section class="admin-dashboard-card">
            <w-icon name="tabler:eye" />
            <div>
              <strong>{{ t(`admin.dashboard.logins`) }}</strong>
              <small
                >{{ adminStore.info.loginsPastDay }}
                <i>{{ t(`admin.dashboard.pastDay`) }}</i></small
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
              :to="`/_admin/` + adminStore.currentSiteId + `/analytics`" />
          </w-card-actions>
        </w-card>
      </div>
      <div>
        <w-card>
          <w-card-section class="admin-dashboard-card">
            <w-icon :name="versionCard.icon" :color="versionCard.color" />
            <div>
              <strong>{{ t(`admin.dashboard.wikiVersion`) }}</strong>
              <small :class="{ pending: versionCard.pending }"
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
      </div>
      <div>
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
      </div>
      <div>
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
      </div>
      <div>
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
      </div>
      <div class="admin-dashboard-logins">
        <w-card>
          <!--
            A banded section marker, the same one every framed list in the language opens with -- the
            tinted strip, the mono overline and a hairline under it. It used to be a plain white row
            with an icon and a bold label, which read as a first list item rather than as the panel's
            own head.
          -->
          <div class="admin-dashboard-panel">
            <w-icon name="tabler:key" />
            <span>{{ t('admin.dashboard.lastLogins') }}</span>
          </div>
          <w-list separator>
            <!--
              Rows link only where the user list is reachable, the same condition the Users card puts on
              its Manage button: the panel itself is `access:admin`, and reading one account is
              `read:users`, so for a reader without it a link would land on a refusal.
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
                <!-- -> The exact moment, in the reader's own pattern and zone, behind the rough one -->
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

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// COMPOSABLES

const dark = useDark()

/*
  A card's footer actions take the CHROME tone, not the accent: the figure above them is already the
  accent, and Cardinal allows one live edge per surface -- two would leave the card with nothing to
  look at first. Which is also why they are flat rather than filled.

  WBtn emits its colour as an inline style, so no `dark:` class can reach it and the theme has to be
  read here: `slate` is a mid-tone picked to read on white, and on the dark card it needs the
  lightened one.
*/
const actionColor = computed(() => (dark.isActive ? 'slate-light' : 'slate'))

/*
  Manage only opens the list, which `read:*` is enough for -- the same rule the nav entries in
  `AdminLayout` use. Creating one is what needs `manage:*`.
*/
const groupsAreVisible = computed(
  () => userStore.can('read:groups') || userStore.can('manage:groups')
)
const usersAreVisible = computed(() => userStore.can('read:users') || userStore.can('manage:users'))

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  loading: 0,
  lastLogins: []
})

// COMPUTED

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

// META

useMeta(() => ({
  title: t('admin.dashboard.title')
}))

// METHODS

/*
  The counter cards read from the admin store, which `AdminLayout` fills once on mount -- `fetchInfo`
  for the counters on `info`, `fetchSites` for the sites card, which counts the list itself.

  The logins panel is fetched here instead, and kept on this page's own state: nothing else shows it,
  and the store is filled by the layout that every admin screen mounts, so putting it there would ask
  for these rows on every one of them.
*/
// -> Reports its own failure rather than throwing on: one panel that could not be filled is not the
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

// -> The store is already filled by the layout; this is the one thing on the page that has to ask
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

<style lang="scss">
.admin-dashboard {
  /*
    The design's own track: as many 230px cards as fit, each taking its share of the remainder. See
    the template for what a 12-column split did instead. The inset is the body's, not the page's --
    the header band above it is full-bleed and pads itself, and the two line up at 24px.
  */
  &-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 12px;
    padding: 20px 24px 40px;
  }

  /*
    The recent-logins panel is a READING panel, not a counter: it holds four lines of names and times,
    and the design caps it at 640px so those lines stay a readable measure instead of stretching to
    whatever the window happens to be. It also spans the grid, so it starts on a row of its own.
  */
  &-logins {
    grid-column: 1 / -1;
    max-width: 640px;
    margin-top: 12px;
  }

  /* -> The banded head of that panel; see the template for why it is a band and not a row */
  &-panel {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-hairline);
    background-color: var(--color-tint);
    color: var(--color-slate);

    @at-root .body--dark & {
      border-bottom-color: var(--color-hairline-dark);
      background-color: var(--color-dark-2);
      color: var(--color-slate-light);
    }

    /*
      `.w-icon`, not `img`: these were raster `<img>` assets and are inline SVG now, so the size has
      to be stated as a font-size (which is what WIcon sizes from) rather than a width.
    */
    > .w-icon {
      font-size: 20px;
      flex: none;
    }

    > span {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
  }

  &-card {
    display: flex;
    align-items: center;

    /* -> See `-panel` above: inline SVG now, so sized by font-size rather than width */
    > .w-icon {
      font-size: 34px;
      margin-inline-end: 14px;
      color: var(--color-slate-soft);
      flex: none;
    }

    strong {
      font-size: 16px;
      font-weight: 300;
      display: block;
      line-height: 1.2;
      color: var(--color-slate);
      padding-inline-start: 2px;

      @at-root .body--dark & {
        color: var(--color-text-secondary-dark);
      }
    }

    /*
      The figure itself: Barlow Condensed at the size a counter card is built around, in the accent.
      This is the one place the accent is used as a NUMBER rather than as an action -- the card's
      whole content is that figure, so it is what the reader's eye is meant to land on.
    */
    span {
      font-family: var(--font-display);
      font-size: 30px;
      line-height: 1.1;
      font-weight: 700;
      color: var(--color-accent);
      display: block;
    }

    small {
      font-family: var(--font-display);
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
      color: var(--color-accent);
      display: block;

      i {
        font-size: 1rem;
        font-style: normal;
      }

      /*
        Amber itself (#ffc107) is picked to read on the dark surface; on the white card it lands
        around 1.7:1, so the light theme takes the darker end of the ramp instead.
      */
      &.pending {
        color: var(--color-amber-9);

        @at-root .body--dark & {
          color: var(--color-amber);
        }
      }
    }
  }

  /*
    A counter card's footer: a flat tinted strip ruled off from the figure above it, its actions
    pushed to the trailing edge and separated by a hairline. The gradient it used to carry was a
    bevel, which is the one thing Cardinal never draws -- and it left the strip reading as a shadow
    under the card rather than as part of it.
  */
  .w-card-actions {
    padding: 0;
    border-top: 1px solid var(--color-hairline);
    background-color: var(--color-paper);

    @at-root .body--dark & {
      border-top-color: var(--color-hairline-dark);
      background-color: var(--color-dark-4);
    }

    .w-btn {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
    }
  }
}
</style>
