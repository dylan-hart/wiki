<template>
  <w-page class="admin-general">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:world" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.general.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.general.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/general`"
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
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <w-settings-card :title="t('admin.general.siteInfo')">
          <w-settings-row
            icon="tabler:home"
            :label="t(`admin.general.siteTitle`)"
            :hint="t(`admin.general.siteTitleHint`)">
            <w-input
              v-model="state.config.title"
              dense
              :rules="rulesTitle"
              hide-bottom-space
              :aria-label="t(`admin.general.siteTitle`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:file-description"
            :label="t(`admin.general.siteDescription`)"
            :hint="t(`admin.general.siteDescriptionHint`)">
            <w-input
              v-model="state.config.description"
              dense
              :aria-label="t(`admin.general.siteDescription`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:world-www"
            :label="t(`admin.general.siteHostname`)"
            :hint="t(`admin.general.siteHostnameHint`)">
            <w-input
              v-model="state.config.hostname"
              dense
              :rules="rulesHostname"
              hide-bottom-space
              :aria-label="t(`admin.general.siteHostname`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.general.footerCopyright')">
          <w-settings-row
            icon="tabler:building"
            :label="t(`admin.general.companyName`)"
            :hint="t(`admin.general.companyNameHint`)">
            <w-input
              v-model="state.config.company"
              dense
              :aria-label="t(`admin.general.companyName`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:copyright"
            :label="t(`admin.general.contentLicense`)"
            :hint="t(`admin.general.contentLicenseHint`)">
            <w-select
              v-model="state.config.contentLicense"
              :options="contentLicenses"
              option-value="value"
              option-label="text"
              emit-value
              map-options
              dense
              :aria-label="t(`admin.general.contentLicense`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:align-left"
            :label="t(`admin.general.footerExtra`)"
            :hint="t(`admin.general.footerExtraHint`)">
            <w-input
              v-model="state.config.footerExtra"
              dense
              :aria-label="t(`admin.general.footerExtra`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.general.features')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:sitemap"
            :label="t(`admin.general.allowBrowse`)"
            :hint="t(`admin.general.allowBrowseHint`)">
            <w-toggle
              v-model="state.config.features.browse"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowBrowse`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:writing"
            :label="t(`admin.general.allowCollaborativeEditing`)"
            :hint="t(`admin.general.allowCollaborativeEditingHint`)">
            <w-toggle
              v-model="state.config.features.collaborativeEditing"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowCollaborativeEditing`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:messages"
            :label="t(`admin.general.allowComments`)"
            :hint="t(`admin.general.allowCommentsHint`)">
            <w-toggle
              v-model="state.config.features.comments"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowComments`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:code"
            :label="t(`admin.general.allowPageScripts`)"
            :hint="t(`admin.general.allowPageScriptsHint`)">
            <w-toggle
              v-model="state.config.features.pageScripts"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowPageScripts`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:user-shield"
            :label="t(`admin.general.allowProfile`)"
            :hint="t(`admin.general.allowProfileHint`)">
            <w-toggle
              v-model="state.config.features.profile"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowProfile`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:users"
            :label="t(`admin.general.showOtherGroups`)"
            :hint="t(`admin.general.showOtherGroupsHint`)">
            <w-toggle
              v-model="state.config.features.showOtherGroups"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.showOtherGroups`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:search"
            :label="t(`admin.general.allowSearch`)"
            :hint="t(`admin.general.allowSearchHint`)">
            <w-toggle
              v-model="state.config.features.search"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.allowSearch`)" />
          </w-settings-row>
          <w-settings-row
            control-width="auto"
            icon="tabler:help-circle"
            :label="t(`admin.general.reasonForChange`)"
            :hint="t(`admin.general.reasonForChangeHint`)">
            <w-btn-toggle
              v-model="state.config.features.reasonForChange"
              :aria-label="t(`admin.general.reasonForChange`)"
              :options="reasonForChangeModes" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card
          class="mt-4"
          v-if="state.config.defaults"
          :title="t('admin.general.defaults')">
          <w-settings-row
            control-width="fixed"
            icon="tabler:stack-3"
            :label="t(`admin.general.defaultTocDepth`)"
            :hint="t(`admin.general.defaultTocDepthHint`)">
            <div class="text-caption">
              {{ t('editor.props.tocMinMaxDepth') }}
              <strong
                >(H{{ state.config.defaults.tocDepth.min }} &rarr; H{{
                  state.config.defaults.tocDepth.max
                }})</strong
              >
            </div>
            <w-range
              v-model="state.config.defaults.tocDepth"
              :min="1"
              :max="6"
              color="primary"
              :left-label-value="`H` + state.config.defaults.tocDepth.min"
              :right-label-value="`H` + state.config.defaults.tocDepth.max"
              :aria-label-min="t('editor.props.tocMinMaxDepth')"
              :aria-label-max="t('editor.props.tocMinMaxDepth')"
              label
              markers />
          </w-settings-row>
        </w-settings-card>
      </div>
      <div class="col-span-12 lg:col-span-5">
        <w-settings-card :title="t('admin.general.logo')">
          <w-settings-row
            control-width="auto"
            icon="tabler:photo"
            :indicator="state.sharpMissing ? '' : null"
            :indicator-text="t(`admin.extensions.requiresSharp`)"
            :label="t(`admin.general.logoUpl`)"
            :hint="t(`admin.general.logoUplHint`)">
            <div class="flex gap-2">
              <w-btn
                :label="t(`common.actions.upload`)"
                icon="tabler:upload"
                color="primary"
                text-color="white"
                @click="uploadLogo" />
              <w-btn
                :label="t(`common.actions.clear`)"
                outline
                icon="tabler:x"
                color="primary"
                :disabled="!state.hasLogo"
                @click="clearLogo" />
            </div>
            <template #preview>
              <w-toolbar class="bg-header text-white" style="height: 64px">
                <!--
                  Keyed off `state.config.id`, not `adminStore.currentSiteId`: the store field flips
                  the instant another site is picked, while the title below only updates when
                  `load()`'s response lands. Both come from the same assignment this way, so the
                  preview can never pair one site's logo with another's title.
                -->
                <!-- Preview only, not a real link -- inert rather than given a fake accessible name -->
                <w-btn dense flat tabindex="-1" aria-hidden="true" v-if="state.config.id">
                  <w-avatar v-if="state.config.logoText" size="34px" square>
                    <img :src="`/_site/` + state.config.id + `/logo?` + logoTimestamp" alt="" />
                  </w-avatar>
                  <img
                    v-else
                    :src="`/_site/` + state.config.id + `/logo?` + logoTimestamp"
                    alt=""
                    style="height: 34px" />
                </w-btn>
                <w-toolbar-title class="text-h6" v-if="state.config.logoText">{{
                  state.config.title
                }}</w-toolbar-title>
              </w-toolbar>
            </template>
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:info-circle"
            :label="t(`admin.general.displaySiteTitle`)"
            :hint="t(`admin.general.displaySiteTitleHint`)">
            <w-toggle
              v-model="state.config.logoText"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.displaySiteTitle`)" />
          </w-settings-row>
          <w-settings-row
            control-width="auto"
            icon="tabler:browser"
            :indicator="state.sharpMissing ? '' : null"
            :indicator-text="t(`admin.extensions.requiresSharp`)"
            :label="t(`admin.general.favicon`)"
            :hint="t(`admin.general.faviconHint`)">
            <div class="flex gap-2">
              <w-btn
                :label="t(`common.actions.upload`)"
                icon="tabler:upload"
                color="primary"
                text-color="white"
                @click="uploadFavicon" />
              <w-btn
                :label="t(`common.actions.clear`)"
                outline
                icon="tabler:x"
                color="primary"
                :disabled="!state.hasFavicon"
                @click="clearFavicon" />
            </div>
            <template #preview>
              <div class="admin-general-favicontabs">
                <div>
                  <w-avatar v-if="state.config.id" size="24px" square>
                    <img
                      :src="`/_site/` + state.config.id + `/favicon?` + faviconTimestamp"
                      :alt="t(`admin.general.favicon`)" />
                  </w-avatar>
                  <div class="text-caption ms-2">{{ state.config.title }}</div>
                </div>
                <div>
                  <w-icon name="tabler:paw" size="24px" color="grey" />
                  <div class="text-caption ms-2">
                    {{ t('admin.general.faviconPreviewSample1') }}
                  </div>
                </div>
                <div>
                  <w-icon name="tabler:mountain" size="24px" color="grey" />
                  <div class="text-caption ms-2">
                    {{ t('admin.general.faviconPreviewSample2') }}
                  </div>
                </div>
              </div>
            </template>
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.general.discovery')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:antenna-bars-5"
            :label="t(`admin.general.discoverable`)"
            :hint="t(`admin.general.discoverableHint`)">
            <w-toggle
              v-model="state.config.discoverable"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.discoverable`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.general.embedding')">
          <w-settings-row
            icon="tabler:frame"
            :label="t(`admin.general.embedAllowedOrigins`)"
            :hint="t(`admin.general.embedAllowedOriginsHint`)">
            <w-input
              v-model="state.config.security.embedAllowedOrigins"
              dense
              :aria-label="t(`admin.general.embedAllowedOrigins`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card
          class="mt-4"
          v-if="state.config.uploads"
          :title="t('admin.general.uploads')">
          <w-settings-row
            icon="tabler:arrow-merge"
            :label="t(`admin.general.uploadConflictBehavior`)"
            :hint="t(`admin.general.uploadConflictBehaviorHint`)">
            <w-select
              v-model="state.config.uploads.conflictBehavior"
              :options="uploadConflictBehaviors"
              option-value="value"
              option-label="label"
              emit-value
              map-options
              dense
              options-dense
              :aria-label="t(`admin.general.uploadConflictBehavior`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.general.urlHandling')">
          <w-settings-row
            icon="tabler:sort-descending"
            :label="t(`admin.general.pageExtensions`)"
            :hint="t(`admin.general.pageExtensionsHint`)">
            <w-input
              v-model="state.config.pageExtensions"
              dense
              :aria-label="t(`admin.general.pageExtensions`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:link"
            :label="t(`admin.general.allowedUrlSchemes`)"
            :hint="t(`admin.general.allowedUrlSchemesHint`)">
            <w-input
              v-model="state.config.allowedUrlSchemes"
              dense
              :aria-label="t(`admin.general.allowedUrlSchemes`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" v-if="state.config.robots" title="SEO">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:robot"
            :label="t(`admin.general.searchAllowIndexing`)"
            :hint="t(`admin.general.searchAllowIndexingHint`)">
            <w-toggle
              v-model="state.config.robots.index"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.searchAllowIndexing`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:vector"
            :label="t(`admin.general.searchAllowFollow`)"
            :hint="t(`admin.general.searchAllowFollowHint`)">
            <w-toggle
              v-model="state.config.robots.follow"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.searchAllowFollow`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:binary-tree"
            :label="t(`admin.general.sitemap`)"
            :hint="t(`admin.general.sitemapHint`)">
            <w-toggle
              v-model="state.config.sitemap"
              :loading="state.loading > 0"
              :aria-label="t(`admin.general.sitemap`)" />
          </w-settings-row>
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
import { notify } from '@/composables/notify'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'
import { useSiteImage } from '@/composables/siteImage'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import { isSharpAvailable } from '@/helpers/siteImages'
import { isValidHostname } from '@/helpers/siteValidation'
import { hostnameRenamedAway } from '@/helpers/siteRename'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const adminStore = useAdminStore()
const siteStore = useSiteStore()

useSiteAdminAccess('site:general')

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.general.title')
}))

/** Must mirror the backend's own defaults for a new site, so every control renders defined. */
function defaultConfig() {
  return {
    id: '',
    hostname: '',
    title: '',
    description: '',
    company: '',
    contentLicense: '',
    footerExtra: '',
    pageExtensions: '',
    allowedUrlSchemes: '',
    logoText: false,
    ratings: {
      index: false,
      follow: false
    },
    features: {
      comments: false,
      pageScripts: false,
      reasonForChange: 'required',
      profile: false
    },
    discoverable: false,
    defaults: {
      tocDepth: {
        min: 1,
        max: 2
      }
    },
    robots: {
      index: false,
      follow: false
    },
    security: {
      embedAllowedOrigins: ''
    },
    sitemap: false
  }
}

const contentLicenses = [
  { value: '', text: t('common.license.none') },
  { value: 'alr', text: t('common.license.alr') },
  { value: 'cc0', text: t('common.license.cc0') },
  { value: 'ccby', text: t('common.license.ccby') },
  { value: 'ccbysa', text: t('common.license.ccbysa') },
  { value: 'ccbynd', text: t('common.license.ccbynd') },
  { value: 'ccbync', text: t('common.license.ccbync') },
  { value: 'ccbyncsa', text: t('common.license.ccbyncsa') },
  { value: 'ccbyncnd', text: t('common.license.ccbyncnd') }
]
const reasonForChangeModes = [
  { value: 'off', label: t('admin.general.reasonForChangeOff') },
  { value: 'optional', label: t('admin.general.reasonForChangeOptional') },
  { value: 'required', label: t('admin.general.reasonForChangeRequired') }
]
const uploadConflictBehaviors = [
  { value: 'overwrite', label: t('admin.general.uploadConflictBehaviorOverwrite') },
  { value: 'reject', label: t('admin.general.uploadConflictBehaviorReject') },
  { value: 'new', label: t('admin.general.uploadConflictBehaviorNew') }
]

const rulesTitle = [(val) => /^[^<>"]+$/.test(val) || t('admin.general.siteTitleInvalidChars')]
const rulesHostname = [(val) => isValidHostname(val) || t('admin.sites.hostnameInvalidChars')]

/**
 * The hostname this site was serving as of the last successful `load()`, for `save()` to diff
 * against. Deliberately not reactive: nothing renders it.
 */
let loadedHostname = ''

const {
  state,
  load,
  save: commit
} = useAdminSettings({
  i18nPrefix: 'admin.general',
  defaults: defaultConfig,
  extraState: {
    // -> Whether there is anything to clear; the previews render either way, falling back to the
    //    default image that is served when a site has none of its own.
    hasLogo: false,
    hasFavicon: false,
    // -> False until proven otherwise, so a slow or failed `system/extensions` call understates the
    //    warning rather than crying wolf while it is still unknown.
    sharpMissing: false
  },
  fetch: (siteId) => API_CLIENT.get(`sites/${siteId}?strict=true`).json(),
  // -> The API sends arrays; the form edits each as one comma-separated string.
  pick: (site) => ({
    ...site,
    pageExtensions: site.pageExtensions.join(','),
    allowedUrlSchemes: (site.allowedUrlSchemes ?? []).join(','),
    security: {
      embedAllowedOrigins: (site.security?.embedAllowedOrigins ?? []).join(',')
    }
  }),
  onLoaded: (site) => {
    state.hasLogo = site?.assets?.logo ?? false
    state.hasFavicon = site?.assets?.favicon ?? false
    loadedHostname = site?.hostname ?? ''
  },
  commit: (siteId, config) =>
    API_CLIENT.put(`sites/${siteId}`, {
      json: {
        hostname: config.hostname ?? '',
        title: config.title ?? '',
        description: config.description ?? '',
        company: config.company ?? '',
        contentLicense: config.contentLicense ?? '',
        footerExtra: config.footerExtra ?? '',
        pageExtensions: parsePageExtensions(config.pageExtensions),
        allowedUrlSchemes: parseAllowedUrlSchemes(config.allowedUrlSchemes),
        logoText: config.logoText ?? false,
        sitemap: config.sitemap ?? false,
        uploads: {
          conflictBehavior: config.uploads?.conflictBehavior ?? 'overwrite'
        },
        robots: {
          index: config.robots?.index ?? false,
          follow: config.robots?.follow ?? false
        },
        security: {
          embedAllowedOrigins: parseEmbedAllowedOrigins(config.security?.embedAllowedOrigins)
        },
        features: {
          browse: config.features?.browse ?? false,
          comments: config.features?.comments ?? false,
          pageScripts: config.features?.pageScripts ?? false,
          profile: config.features?.profile ?? false,
          reasonForChange: config.features?.reasonForChange ?? 'required',
          search: config.features?.search ?? false,
          showOtherGroups: config.features?.showOtherGroups ?? false
        },
        discoverable: config.discoverable ?? false,
        defaults: {
          tocDepth: {
            min: config.defaults?.tocDepth?.min ?? 1,
            max: config.defaults?.tocDepth?.max ?? 2
          }
        }
      }
    }).json(),
  onSaved: () => adminStore.fetchSites(),
  // -> Re-resolving `siteStore` from `window.location.hostname` is right for every field except
  //    hostname itself: the PUT above drops the OLD hostname from the server's mappings, so that
  //    reload would mis-load whatever site claims it next, or throw. Following the rename client
  //    side is not an option either -- navigating to the new hostname guesses at DNS/proxy config
  //    this code cannot confirm. The rest of the admin API is addressed by siteId, so only
  //    page-serving under the old hostname stops working.
  onSavedCurrentSite: (config) => {
    if (hostnameRenamedAway(loadedHostname, config.hostname)) {
      notify({
        type: 'warning',
        message: t('admin.general.hostnameChangedWarning', { hostname: config.hostname }),
        timeout: 0
      })
    } else {
      siteStore.loadSite(window.location.hostname)
    }
  }
})

const {
  upload: uploadLogo,
  clear: clearLogo,
  timestamp: logoTimestamp
} = useSiteImage('logo', {
  siteId: () => adminStore.currentSiteId,
  has: toRef(state, 'hasLogo'),
  i18nPrefix: 'admin.general.logo',
  // -> One shared message for both uploaders on this page, hence not the per-image default
  invalidTypeKey: 'admin.general.imageUploadInvalidType',
  loading: toRef(state, 'loading')
})

const {
  upload: uploadFavicon,
  clear: clearFavicon,
  timestamp: faviconTimestamp
} = useSiteImage('favicon', {
  siteId: () => adminStore.currentSiteId,
  has: toRef(state, 'hasFavicon'),
  i18nPrefix: 'admin.general.favicon',
  invalidTypeKey: 'admin.general.imageUploadInvalidType',
  loading: toRef(state, 'loading')
})

/** The form holds this as a comma-separated string; the API expects an array. */
function parsePageExtensions(value) {
  const extensions = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [
    ...new Set(extensions.map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.length > 0))
  ]
}

/** No scheme-name validation here: `api/schemas/site.ts` is what enforces the pattern. */
function parseAllowedUrlSchemes(value) {
  const schemes = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [
    ...new Set(
      schemes.map((scheme) => scheme.trim().toLowerCase()).filter((scheme) => scheme.length > 0)
    )
  ]
}

/**
 * Lowercased because these end up as literal `frame-ancestors` CSP source-list tokens and
 * `api/schemas/site.ts` only accepts a lowercase origin.
 */
function parseEmbedAllowedOrigins(value) {
  const origins = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [
    ...new Set(
      origins.map((origin) => origin.trim().toLowerCase()).filter((origin) => origin.length > 0)
    )
  ]
}

/** `loadedHostname` only moves on a stored change: a refused save is still an unsaved rename. */
async function save() {
  if (await commit()) {
    loadedHostname = state.config.hostname ?? ''
  }
}

// -> Site-independent, so once on mount rather than inside `load()`, which re-runs per site switch.
onMounted(async () => {
  state.sharpMissing = !(await isSharpAvailable())
})
</script>

<style>
/* Flat on purpose: a `&-suffix` selector is Sass string concatenation, and native CSS nesting
   silently drops such a rule rather than matching it. */
.admin-general-favicontabs {
  overflow: hidden;
  display: flex;
  padding: 5px 5px 0 12px;
}
.body--light .admin-general-favicontabs {
  background-color: rgba(0, 0, 0, 0.1);
}
.body--dark .admin-general-favicontabs {
  background-color: rgba(255, 255, 255, 0.1);
}
.admin-general-favicontabs > div {
  display: flex;
  padding: 4px 12px;
  position: relative;
  align-items: center;
}
.admin-general-favicontabs > div:first-child {
  border: 1px solid #fff;
  border-bottom: none;
  box-shadow: 0 0 5px 0 rgba(0, 0, 0, 0.2);
}
.body--light .admin-general-favicontabs > div:first-child {
  background: linear-gradient(to top, #fff, rgba(255, 255, 255, 0.75));
  border-color: #fff;
}
.body--dark .admin-general-favicontabs > div:first-child {
  background: linear-gradient(to top, var(--color-dark-6), var(--color-dark-5));
  border-color: var(--color-dark-6);
}
</style>
