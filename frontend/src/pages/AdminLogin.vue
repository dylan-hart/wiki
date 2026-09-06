<template>
  <w-page class="admin-login">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:login" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.login.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.login.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/auth`"
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
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- Experience -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.login.experience')">
          <!--
            The background image spans the row under both the text and the buttons, which is what
            `WSettingsRow`'s `preview` slot is for -- the same shape `AdminGeneral`'s logo and
            favicon rows use.
          -->
          <w-settings-row
            control-width="auto"
            icon="tabler:photo"
            :indicator="state.sharpMissing ? '' : null"
            :indicator-text="t(`admin.extensions.requiresSharp`)"
            :label="t(`admin.login.background`)"
            :hint="t(`admin.login.backgroundHint`)">
            <div class="flex gap-2">
              <w-btn
                :label="t(`common.actions.upload`)"
                icon="tabler:upload"
                color="primary"
                text-color="white"
                @click="uploadBg" />
              <w-btn
                :label="t(`common.actions.clear`)"
                outline
                icon="tabler:x"
                color="primary"
                :disabled="!state.hasBg"
                @click="clearBg" />
            </div>
            <template #preview>
              <img
                v-if="adminStore.currentSiteId"
                class="admin-login-bg"
                :src="`/_site/` + adminStore.currentSiteId + `/loginBg?` + bgTimestamp"
                :alt="t(`admin.login.background`)" />
            </template>
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:layout-sidebar-right-collapse"
            :label="t(`admin.login.bypassScreen`)"
            :hint="t(`admin.login.bypassScreenHint`)">
            <w-toggle
              v-model="state.config.autoLogin"
              :loading="state.loading > 0"
              :aria-label="t(`admin.login.bypassScreen`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:lock-off"
            :label="t(`admin.login.bypassUnauthorized`)"
            :hint="t(`admin.login.bypassUnauthorizedHint`)">
            <w-toggle
              v-model="state.config.bypassUnauthorized"
              :loading="state.loading > 0"
              :aria-label="t(`admin.login.bypassUnauthorized`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:chevrons-right"
            :label="t(`admin.login.loginRedirect`)"
            :hint="t(`admin.login.loginRedirectHint`)">
            <w-input
              v-model="state.config.loginRedirect"
              dense
              :rules="[
                (val) =>
                  state.invalidCharsRegex.test(val) || t('admin.login.loginRedirectInvalidChars')
              ]"
              hide-bottom-space
              :aria-label="t(`admin.login.loginRedirect`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:chevron-right"
            :label="t(`admin.login.welcomeRedirect`)"
            :hint="t(`admin.login.welcomeRedirectHint`)">
            <w-input
              v-model="state.config.welcomeRedirect"
              dense
              :rules="[
                (val) =>
                  state.invalidCharsRegex.test(val) || t('admin.login.welcomeRedirectInvalidChars')
              ]"
              hide-bottom-space
              :aria-label="t(`admin.login.welcomeRedirect`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:logout"
            :label="t(`admin.login.logoutRedirect`)"
            :hint="t(`admin.login.logoutRedirectHint`)">
            <w-input
              v-model="state.config.logoutRedirect"
              dense
              :rules="[
                (val) =>
                  state.invalidCharsRegex.test(val) || t('admin.login.logoutRedirectInvalidChars')
              ]"
              hide-bottom-space
              :aria-label="t(`admin.login.logoutRedirect`)" />
          </w-settings-row>
        </w-settings-card>
      </div>
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- Providers -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.login.providers')">
          <!--
            A drag-ordered list, not a stack of settings: the rows are reordered by the handle at
            their leading edge and each names a provider rather than a setting, so they stay
            `WItem`s inside a plain section under the strip. Forcing a 34px plate in front of a drag
            handle would put two leading affordances on one row.
          -->
          <w-card-section class="admin-login-providers">
            <sortable
              :list="state.providers"
              item-key="id"
              :options="sortableOptions"
              @end="updateAuthPosition">
              <template #item="{ element }">
                <w-item>
                  <w-item-section side>
                    <w-icon class="handle" name="tabler:grip-horizontal" />
                  </w-item-section>
                  <w-item-section side>
                    <w-icon :name="`img:` + element.activeStrategy.strategy.icon" />
                  </w-item-section>
                  <w-item-section>
                    <w-item-label>{{ element.activeStrategy.displayName }}</w-item-label>
                    <w-item-label caption>{{ element.activeStrategy.strategy.title }}</w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-toggle
                      v-model="element.isVisible"
                      :label="t('admin.login.visible')"
                      :aria-label="element.activeStrategy.displayName" />
                  </w-item-section>
                </w-item>
              </template>
            </sortable>
            <w-card class="bg-info text-white rounded mt-2">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:info-circle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">{{
                  t('admin.login.providersVisbleWarning')
                }}</w-card-section>
              </w-card-section>
            </w-card>
          </w-card-section>
        </w-settings-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, toRef } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'
import { useSiteImage } from '@/composables/siteImage'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import { isSharpAvailable } from '@/helpers/siteImages'

import { Sortable } from 'sortablejs-vue3'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

// ACCESS
// -> Task #684: gates this page behind `site:login` (or `manage:sites`), redirecting away from a
//    site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:login')

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.login.title')
}))

// DATA

/**
 * Fallbacks for keys a site may not have stored yet, so that every control renders with a defined
 * value. Must mirror the `auth` defaults used by the backend when creating a site.
 */
function defaultConfig() {
  return {
    autoLogin: false,
    bypassUnauthorized: false,
    hideLocal: false,
    loginRedirect: '/',
    welcomeRedirect: '/',
    logoutRedirect: '/'
  }
}

const { state, load, save } = useAdminSettings({
  i18nPrefix: 'admin.login',
  defaults: defaultConfig,
  extraState: {
    invalidCharsRegex: /^[^<>"]+$/,
    providers: [],
    // -> Whether this site has a background of its own, i.e. whether there is anything to clear. The
    //    preview always renders: without one it shows the default the login page falls back to.
    hasBg: false,
    // -> Drives the "requires Sharp" indicator on the background uploader. Starts false rather than
    //    true so a slow or failed `system/extensions` call understates the warning instead of crying
    //    wolf while it's still unknown.
    sharpMissing: false
  },
  fetch: (siteId) =>
    Promise.all([
      API_CLIENT.get(`sites/${siteId}?strict=true`).json(),
      API_CLIENT.get(`sites/${siteId}/auth/strategies`, {
        searchParams: { visibleOnly: false }
      }).json()
    ]),
  pick: ([site]) => site?.auth ?? {},
  onLoaded: ([site, providers]) => {
    state.providers = providers ?? []
    state.hasBg = site?.assets?.loginBg ?? false
  },
  commit: (siteId, config) =>
    API_CLIENT.put(`sites/${siteId}`, {
      json: {
        auth: {
          autoLogin: config.autoLogin ?? false,
          bypassUnauthorized: config.bypassUnauthorized ?? false,
          hideLocal: config.hideLocal ?? false,
          loginRedirect: config.loginRedirect ?? '/',
          welcomeRedirect: config.welcomeRedirect ?? '/',
          logoutRedirect: config.logoutRedirect ?? '/'
        },
        // -> Order comes from the current position in the drag-sortable list
        authStrategies: state.providers.map((provider, index) => ({
          id: provider.id,
          order: index,
          isVisible: provider.isVisible ?? false
        }))
      }
    }).json()
})

const sortableOptions = {
  handle: '.handle',
  animation: 150
}

// COMPOSABLES (site images)

const {
  upload: uploadBg,
  clear: clearBg,
  timestamp: bgTimestamp
} = useSiteImage('loginBg', {
  siteId: () => adminStore.currentSiteId,
  has: toRef(state, 'hasBg'),
  i18nPrefix: 'admin.login.bg',
  loading: toRef(state, 'loading')
})

// METHODS

function updateAuthPosition(ev) {
  const item = state.providers.splice(ev.oldIndex, 1)[0]
  state.providers.splice(ev.newIndex, 0, item)
}

// MOUNTED

// -> Site-independent, so this runs once on mount rather than on every `load()` (which re-runs per
//    site switch). Drives the "requires Sharp" indicator on the background uploader.
onMounted(async () => {
  state.sharpMissing = !(await isSharpAvailable())
})
</script>

<style lang="scss">
.admin-login-bg {
  width: 100%;
  height: 140px;
  object-fit: cover;
}

.admin-login-providers {
  .w-item {
    @at-root .body--light & {
      background-color: $grey-2;
    }
    @at-root .body--dark & {
      background-color: $dark-5;
    }

    & + .w-item {
      margin-top: 8px;
    }
  }

  .handle {
    cursor: ns-resize;
  }
}
</style>
