<template>
  <w-page class="admin-general">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-web.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.general.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.general.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/general`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="secondary"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!-- ----------------------- -->
        <!-- Site Info -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.general.siteInfo') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="home" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.siteTitle`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.siteTitleHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.title"
                dense
                :rules="rulesTitle"
                hide-bottom-space
                :aria-label="t(`admin.general.siteTitle`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="select-all" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.siteDescription`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.siteDescriptionHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.description"
                dense
                :aria-label="t(`admin.general.siteDescription`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="dns" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.siteHostname`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.siteHostnameHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.hostname"
                dense
                :rules="rulesHostname"
                hide-bottom-space
                :aria-label="t(`admin.general.siteHostname`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Footer / Copyright -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.general.footerCopyright') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="building" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.companyName`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.companyNameHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.company"
                dense
                :aria-label="t(`admin.general.companyName`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="copyright" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.contentLicense`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.contentLicenseHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-select
                outlined
                v-model="state.config.contentLicense"
                :options="contentLicenses"
                option-value="value"
                option-label="text"
                emit-value
                map-options
                dense
                :aria-label="t(`admin.general.contentLicense`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="subtitles" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.footerExtra`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.footerExtraHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.footerExtra"
                dense
                :aria-label="t(`admin.general.footerExtra`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- FEATURES -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.general.features') }}</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="tree-structure" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowBrowse`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.allowBrowseHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.browse"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.allowBrowse`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="user-typing-using-typewriter" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowCollaborativeEditing`) }}</w-item-label>
              <w-item-label caption>
                {{ t(`admin.general.allowCollaborativeEditingHint`) }}
              </w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.collaborativeEditing"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.allowCollaborativeEditing`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="discussion-forum" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowComments`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.allowCommentsHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.comments"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.allowComments`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="administrator-male" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowProfile`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.allowProfileHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.profile"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.allowProfile`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="team" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.showOtherGroups`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.showOtherGroupsHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.showOtherGroups"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.showOtherGroups`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="search" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowSearch`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.allowSearchHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.features.search"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.allowSearch`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="confusion" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.reasonForChange`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.reasonForChangeHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.config.features.reasonForChange"
                push
                glossy
                no-caps
                toggle-color="primary"
                :aria-label="t(`admin.general.reasonForChange`)"
                :options="reasonForChangeModes" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Defaults -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4" v-if="state.config.defaults">
          <w-card-header>{{ t('admin.general.defaults') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="depth" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.defaultTocDepth`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.defaultTocDepthHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section class="flex-none ps-2" style="min-width: 180px">
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
            </w-item-section>
          </w-item>
        </w-card>
      </div>
      <div class="col-span-12 lg:col-span-5">
        <!-- ----------------------- -->
        <!-- Logo -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.general.logo') }}</w-card-header>
          <w-item>
            <blueprint-icon
              class="self-start"
              icon="butterfly"
              :indicator="state.sharpMissing ? '' : null"
              :indicator-text="t(`admin.extensions.requiresSharp`)" />
            <w-item-section>
              <div class="flex">
                <w-item-section>
                  <w-item-label>{{ t(`admin.general.logoUpl`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.general.logoUplHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section class="flex-none">
                  <div class="flex gap-2">
                    <w-btn
                      :label="t(`common.actions.upload`)"
                      unelevated
                      icon="la:upload"
                      color="primary"
                      text-color="white"
                      @click="uploadLogo" />
                    <w-btn
                      :label="t(`common.actions.clear`)"
                      outline
                      icon="la:times"
                      color="primary"
                      :disabled="!state.hasLogo"
                      @click="clearLogo" />
                  </div>
                </w-item-section>
              </div>
              <w-toolbar class="bg-header mt-4 rounded text-white" style="height: 64px">
                <!--
                  Keyed off `state.config.id`, not `adminStore.currentSiteId`: the store field flips
                  the instant a different site is picked, but the title/logoText text below comes from
                  `state.config`, which only updates once `load()`'s response for the NEW site lands.
                  Using the store id here showed the new site's image next to the old site's title for
                  the length of that request. `state.config.id` changes in the exact same assignment as
                  the text, so the two can never disagree.
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
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="information" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.displaySiteTitle`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.displaySiteTitleHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.logoText"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.displaySiteTitle`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon
              class="self-start"
              icon="starfish"
              :indicator="state.sharpMissing ? '' : null"
              :indicator-text="t(`admin.extensions.requiresSharp`)" />
            <w-item-section>
              <div class="flex">
                <w-item-section>
                  <w-item-label>{{ t(`admin.general.favicon`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.general.faviconHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section class="flex-none">
                  <div class="flex gap-2">
                    <w-btn
                      :label="t(`common.actions.upload`)"
                      unelevated
                      icon="la:upload"
                      color="primary"
                      text-color="white"
                      @click="uploadFavicon" />
                    <w-btn
                      :label="t(`common.actions.clear`)"
                      outline
                      icon="la:times"
                      color="primary"
                      :disabled="!state.hasFavicon"
                      @click="clearFavicon" />
                  </div>
                </w-item-section>
              </div>
              <div class="admin-general-favicontabs mt-4">
                <div>
                  <!-- Same reasoning as the logo preview toolbar above: keyed off `state.config.id`
                       so this can never show a new site's favicon beside the old site's title. -->
                  <w-avatar v-if="state.config.id" size="24px" square>
                    <img
                      :src="`/_site/` + state.config.id + `/favicon?` + faviconTimestamp"
                      :alt="t(`admin.general.favicon`)" />
                  </w-avatar>
                  <div class="text-caption ms-2">{{ state.config.title }}</div>
                </div>
                <div>
                  <w-icon name="la:otter" size="24px" color="grey" />
                  <div class="text-caption ms-2">
                    {{ t('admin.general.faviconPreviewSample1') }}
                  </div>
                </div>
                <div>
                  <w-icon name="la:mountain" size="24px" color="grey" />
                  <div class="text-caption ms-2">
                    {{ t('admin.general.faviconPreviewSample2') }}
                  </div>
                </div>
              </div>
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Discovery -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.general.discovery') }}</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="cellular-network" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.discoverable`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.discoverableHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.discoverable"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.discoverable`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Uploads -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4" v-if="state.config.uploads">
          <w-card-header>{{ t('admin.general.uploads') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="merge-files" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.uploadConflictBehavior`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.general.uploadConflictBehaviorHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-select
                outlined
                v-model="state.config.uploads.conflictBehavior"
                :options="uploadConflictBehaviors"
                option-value="value"
                option-label="label"
                emit-value
                map-options
                dense
                options-dense
                :aria-label="t(`admin.general.uploadConflictBehavior`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- URL Handling -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.general.urlHandling') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="sort-by-follow-up-date" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.pageExtensions`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.pageExtensionsHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.pageExtensions"
                dense
                :aria-label="t(`admin.general.pageExtensions`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="link" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.allowedUrlSchemes`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.allowedUrlSchemesHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.config.allowedUrlSchemes"
                dense
                :aria-label="t(`admin.general.allowedUrlSchemes`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- SEO -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4" v-if="state.config.robots">
          <w-card-header>SEO</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="bot" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.searchAllowIndexing`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.searchAllowIndexingHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.robots.index"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.searchAllowIndexing`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="polyline" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.searchAllowFollow`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.searchAllowFollowHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.robots.follow"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.searchAllowFollow`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="genealogy" />
            <w-item-section>
              <w-item-label>{{ t(`admin.general.sitemap`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.general.sitemapHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.sitemap"
                :loading="state.loading > 0"
                :aria-label="t(`admin.general.sitemap`)" />
            </w-item-section>
          </w-item>
        </w-card>
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

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// ACCESS
// -> Task #684: gates this page behind `site:general` (or `manage:sites`), redirecting away from a
//    site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:general')

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.general.title')
}))

// DATA

/**
 * Fallbacks for config keys a site may not have stored yet, so that every control renders with a
 * defined value. Must mirror the defaults used by the backend when creating a site.
 */
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
 * The hostname this site was serving as of the last successful `load()`. Not reactive on purpose --
 * it exists only for `save()` to diff against, never rendered, so a plain closure variable is enough
 * and avoids it showing up as unrelated Vue reactivity.
 */
let loadedHostname = ''

// COMPOSABLES

const {
  state,
  load,
  save: commit
} = useAdminSettings({
  i18nPrefix: 'admin.general',
  defaults: defaultConfig,
  extraState: {
    // -> Whether this site has a logo / favicon of its own, i.e. whether there is anything to clear.
    //    The previews always render: without one they show the default that is served instead.
    hasLogo: false,
    hasFavicon: false,
    // -> Drives the "requires Sharp" indicator on the logo / favicon uploaders. Starts false rather
    //    than true so a slow or failed `system/extensions` call understates the warning instead of
    //    crying wolf while it's still unknown.
    sharpMissing: false
  },
  fetch: (siteId) => API_CLIENT.get(`sites/${siteId}?strict=true`).json(),
  // -> The form holds page extensions (and allowed URL schemes) as a comma-separated string; the
  //    API sends an array
  pick: (site) => ({
    ...site,
    pageExtensions: site.pageExtensions.join(','),
    allowedUrlSchemes: (site.allowedUrlSchemes ?? []).join(',')
  }),
  onLoaded: (site) => {
    state.hasLogo = site?.assets?.logo ?? false
    state.hasFavicon = site?.assets?.favicon ?? false
    // -> The hostname this site was actually serving as of this load, so save() can tell a real
    //    rename apart from every other field change. See the comment in save() for why that matters.
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
        features: {
          browse: config.features?.browse ?? false,
          comments: config.features?.comments ?? false,
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
  // -> Decision, so it doesn't silently regress: when the admin is editing the very site
  //    currently serving their browser tab, the old code unconditionally re-resolved
  //    `siteStore` from `window.location.hostname`. That is correct for every field EXCEPT
  //    hostname itself -- `updateSite()` calls `reloadCache()` synchronously, so the instant the
  //    PUT above resolves, the OLD hostname no longer maps to this site at all. Re-resolving it
  //    then either mis-loads whatever other site (if any) claims that hostname next, or throws --
  //    either way `siteStore` ends up mismatched or blank with no warning to the admin.
  //
  //    There is no client-side fix that "just follows" a hostname rename: the browser's address
  //    bar still says the old hostname, and a `window.location` navigation to the new one is a
  //    guess about DNS/reverse-proxy config this code has no way to confirm. So: skip the stale
  //    reload and tell the admin instead. The admin API itself is host-agnostic (every other
  //    admin action here is addressed by siteId, not hostname), so nothing else on this screen
  //    breaks -- only page-serving under the old hostname stops working, and only once they
  //    navigate away from it.
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

// COMPOSABLES (site images)

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

/**
 * The form holds page extensions as a comma-separated string, while the API expects an array.
 */
function parsePageExtensions(value) {
  const extensions = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [
    ...new Set(extensions.map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.length > 0))
  ]
}

/**
 * Same shape as `parsePageExtensions` -- the form holds this as a comma-separated string, the API
 * wants an array. Just splits/trims/lowercases/dedupes; the backend schema (`api/sites.ts`) is what
 * enforces the actual scheme-name pattern.
 */
function parseAllowedUrlSchemes(value) {
  const schemes = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [
    ...new Set(
      schemes.map((scheme) => scheme.trim().toLowerCase()).filter((scheme) => scheme.length > 0)
    )
  ]
}

/**
 * The hostname `save()` will diff the next one against only moves once the change is actually
 * stored -- a refused save leaves this screen still editing a rename away from `loadedHostname`.
 */
async function save() {
  if (await commit()) {
    loadedHostname = state.config.hostname ?? ''
  }
}

// MOUNTED

// -> Site-independent, so this runs once on mount rather than on every `load()` (which re-runs per
//    site switch). Drives the "requires Sharp" indicator on both uploaders.
onMounted(async () => {
  state.sharpMissing = !(await isSharpAvailable())
})
</script>

<style lang="scss">
.admin-general {
  &-favicontabs {
    overflow: hidden;
    border-radius: 5px;
    display: flex;
    padding: 5px 5px 0 12px;

    @at-root .body--light & {
      background-color: rgba(0, 0, 0, 0.1);
    }

    @at-root .body--dark & {
      background-color: rgba(255, 255, 255, 0.1);
    }

    > div {
      display: flex;
      padding: 4px 12px;
      position: relative;
      align-items: center;

      &:first-child {
        border: 1px solid #fff;
        border-bottom: none;
        border-radius: 7px 7px 0 0;
        box-shadow: 0 0 5px 0 rgba(0, 0, 0, 0.2);

        @at-root .body--light & {
          background: linear-gradient(to top, #fff, rgba(255, 255, 255, 0.75));
          border-color: #fff;
        }

        @at-root .body--dark & {
          background: linear-gradient(to top, $dark-6, $dark-5);
          border-color: $dark-6;
        }
      }
    }
  }
}
</style>
