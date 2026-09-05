<template>
  <w-page class="admin-auth">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-security-lock.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.auth.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.auth.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/auth`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <!--
      The same shape the storage view uses for a list beside what it selects: the list is as wide as
      it needs to be and the panel takes what is left, wrapping onto its own row when there is no room
      for both. A 12-column grid cannot say that -- the list is 350px, not some number of twelfths --
      which is how this ended up with the panel on `col-span-full`, i.e. underneath.
    -->
    <div class="flex flex-wrap p-4 gap-4">
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 350px" padding dark>
            <w-item
              v-for="str of state.activeStrategies"
              :key="str.id"
              active-class="bg-primary text-white"
              :active="state.selectedStrategy === str.id"
              @click="state.selectedStrategy = str.id"
              clickable>
              <w-item-section side><w-icon :name="`img:` + str.strategy.icon" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ str.displayName }}</w-item-label>
                <w-item-label caption>{{ str.strategy.title }}</w-item-label>
              </w-item-section>
              <!--
                Its own section rather than sharing the light's: the light is `height: 100%` against
                whatever contains it, and a wrapper sized to its own content is not the row.
              -->
              <w-item-section side v-if="str.isNew">
                <!-- -> Nothing on the server answers to this one yet; Apply is what creates it -->
                <w-badge color="warning" rounded>{{ t('admin.auth.unsaved') }}</w-badge>
              </w-item-section>
              <w-item-section side>
                <status-light
                  :color="str.isEnabled ? `positive` : `negative`"
                  :pulse="str.isEnabled" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
        <!--
          Always shown, rather than only with the experimental flag on: adding a strategy is what this
          screen is for once a wiki has more than the built-in local one, and a button that is not
          there cannot say that none of the installed modules is addable. The menu says it instead.
        -->
        <w-btn
          class="mt-2 w-full"
          color="primary"
          icon="la:plus"
          :label="t(`admin.auth.addStrategy`)">
          <!--
            No `auto-close`: with a filter field in the content, that would dismiss the menu the
            instant the field is clicked (`w-menu`'s content click handler treats every click inside
            as a selection) -- so `addStrategy` closes it explicitly instead, the same way
            `EditorEmojiMenu.vue` / `EditorCodeBlockMenu.vue` handle a filterable menu.
          -->
          <w-menu ref="addStrategyMenuRef" fit max-width="300px" @show="state.strategyFilter = ''">
            <w-list v-if="availableStrategies.length < 1" separator>
              <!-- -> The local module is filtered out: it is already configured, and a second copy
                   of it holds no credentials -->
              <w-item>
                <w-item-section>
                  <w-item-label caption>{{ t('admin.auth.noModulesToAdd') }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
            <template v-else>
              <!--
                Narrows the list below as the admin types: a case-insensitive substring match against
                each module's title, the same pattern `AdminIcons.vue`'s icon-set search uses --
                unworkable to scroll through flat once Feature 355 adds a dozen branded presets.
              -->
              <div class="p-2">
                <w-input
                  v-model="state.strategyFilter"
                  outlined
                  dense
                  clearable
                  hide-bottom-space
                  :label="t(`admin.auth.filterModules`)"
                  :aria-label="t(`admin.auth.filterModules`)">
                  <template #prepend><w-icon name="la:search" /></template>
                </w-input>
              </div>
              <w-separator />
              <w-list separator>
                <w-item
                  v-for="str of filteredAvailableStrategies"
                  :key="str.key"
                  clickable
                  @click="addStrategy(str)">
                  <w-item-section avatar>
                    <w-avatar rounded color="dark" text-color="white">
                      <w-icon :name="`img:` + str.icon" />
                    </w-avatar>
                  </w-item-section>
                  <w-item-section>
                    <w-item-label
                      ><strong>{{ str.title }}</strong></w-item-label
                    >
                    <w-item-label caption lines="2">{{ str.description }}</w-item-label>
                  </w-item-section>
                </w-item>
                <w-item v-if="filteredAvailableStrategies.length < 1">
                  <w-item-section>
                    <w-item-label caption>{{ t('admin.auth.noModulesMatchFilter') }}</w-item-label>
                  </w-item-section>
                </w-item>
              </w-list>
            </template>
          </w-menu>
        </w-btn>
      </div>
      <!-- -> `min-w-0`, or a long value inside a field would push the panel wider than the row -->
      <div class="min-w-0 flex-1" v-if="state.strategy.id">
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.auth.info') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="information" />
            <w-item-section>
              <w-item-label>{{ t(`admin.auth.infoName`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.auth.infoNameHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.strategy.displayName"
                dense
                hide-bottom-space
                :aria-label="t(`admin.auth.infoName`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="shutdown" />
            <w-item-section>
              <w-item-label>{{ t(`admin.auth.enabled`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.auth.enabledHint`) }}</w-item-label>
              <w-item-label class="text-deep-orange" v-if="isBuiltInLocal" caption>{{
                t(`admin.auth.enabledForced`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.strategy.isEnabled"
                :disabled="isBuiltInLocal"
                :aria-label="t(`admin.auth.enabled`)" />
            </w-item-section>
          </w-item>
          <w-item v-if="noVisibleSitesWarning">
            <w-item-section>
              <w-banner
                :class="
                  dark.isActive ? `bg-deep-orange text-white` : `bg-orange-1 text-deep-orange`
                ">
                {{ t('admin.auth.noVisibleSitesWarning') }}
              </w-banner>
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <!-- Exactly one registration control per module, matching what it actually does: a
               form-based module (Local, LDAP) registers visitors itself, a redirect-based provider
               auto-provisions whoever it signs in -- the two are enforced separately server-side, so
               only the one that applies to this module is ever shown. -->
          <w-item tag="label" v-if="state.strategy.strategy.useForm">
            <blueprint-icon icon="register" />
            <w-item-section>
              <w-item-label>{{ t(`admin.auth.selfRegistration`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.auth.selfRegistrationHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.strategy.selfRegistration"
                :aria-label="t(`admin.auth.selfRegistration`)" />
            </w-item-section>
          </w-item>
          <w-item tag="label" v-else>
            <blueprint-icon icon="register" />
            <w-item-section>
              <w-item-label>{{ t(`admin.auth.autoProvision`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.auth.autoProvisionHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.strategy.autoProvision"
                :aria-label="t(`admin.auth.autoProvision`)" />
            </w-item-section>
          </w-item>
          <!-- Meaningful for a redirect-based provider always, and for a form-based module too when
               it declares itself `provisionable`: linking by email is what findOrCreateProviderUser()
               does for a returning identity, a path a redirect-based provider always takes and LDAP
               reaches too (its authenticate() throws ProvisionableLoginError on a successful bind --
               see models/login.ts's dispatch). Local never takes this path -- it resolves directly
               against its own stored password -- so it stays excluded. -->
          <template
            v-if="!state.strategy.strategy.useForm || state.strategy.strategy.provisionable">
            <w-separator class="my-2" inset />
            <w-item tag="label">
              <blueprint-icon icon="link" />
              <w-item-section>
                <w-item-label>{{ t(`admin.auth.trustEmailForLinking`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.auth.trustEmailForLinkingHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-toggle
                  v-model="state.strategy.trustEmailForLinking"
                  :aria-label="t(`admin.auth.trustEmailForLinking`)" />
              </w-item-section>
            </w-item>
          </template>
          <template
            v-if="
              state.strategy.strategy.useForm
                ? state.strategy.selfRegistration
                : state.strategy.autoProvision
            ">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="team" />
              <w-item-section>
                <w-item-label>{{ t(`admin.auth.autoEnrollGroups`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.auth.autoEnrollGroupsHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-select
                  outlined
                  :options="state.groups"
                  v-model="state.strategy.autoEnrollGroups"
                  multiple
                  map-options
                  emit-value
                  option-value="id"
                  option-label="name"
                  options-dense
                  dense
                  hide-bottom-space
                  :aria-label="t(`admin.users.groups`)"
                  :loading="state.loadingGroups">
                  <template #selected>
                    <div class="text-caption" v-if="state.strategy.autoEnrollGroups?.length > 1">
                      <i18n-t keypath="admin.users.groupsSelected">
                        <template #count>
                          <strong>{{ state.strategy.autoEnrollGroups?.length }}</strong>
                        </template>
                      </i18n-t>
                    </div>
                    <div
                      class="text-caption"
                      v-else-if="state.strategy.autoEnrollGroups?.length === 1">
                      <i18n-t keypath="admin.users.groupSelected">
                        <template #group
                          ><strong>{{ selectedGroupName }}</strong></template
                        >
                      </i18n-t>
                    </div>
                    <span v-else />
                  </template>
                  <template #option="{ itemProps, opt, selected, toggleOption }">
                    <w-item v-bind="itemProps">
                      <w-item-section side>
                        <w-checkbox
                          dense
                          :model-value="selected"
                          @update:model-value="toggleOption(opt)" />
                      </w-item-section>
                      <w-item-section
                        ><w-item-label>{{ opt.name }}</w-item-label></w-item-section
                      >
                    </w-item>
                  </template>
                </w-select>
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="private" />
              <w-item-section>
                <w-item-label>{{ t(`admin.auth.allowedEmailRegex`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.auth.allowedEmailRegexHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  outlined
                  v-model="state.strategy.allowedEmailRegex"
                  dense
                  hide-bottom-space
                  :aria-label="t(`admin.auth.allowedEmailRegex`)"
                  prefix="/"
                  suffix="/" />
              </w-item-section>
            </w-item>
            <!--
              A friendlier alternative to allowedEmailRegex above, for the common case of restricting
              self-registration by domain rather than a hand-written pattern. Scoped to self-registration
              specifically (useForm only), not shown for a redirect-based provider's autoProvision half --
              matching selfRegistration's own scope (OpenProject #2469).
            -->
            <template v-if="state.strategy.strategy.useForm">
              <w-separator class="my-2" inset />
              <w-item>
                <blueprint-icon icon="private" />
                <w-item-section>
                  <w-item-label>{{ t(`admin.auth.allowedEmailDomains`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.auth.allowedEmailDomainsHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section>
                  <!--
                    Free-entry list of strings, same pattern as PageTags.vue: no predefined options, `create`
                    is what lets a domain that is not in the list yet be typed in.
                  -->
                  <w-select
                    outlined
                    v-model="state.strategy.allowedEmailDomains"
                    :options="[]"
                    dense
                    options-dense
                    use-input
                    create
                    multiple
                    use-chips
                    hide-bottom-space
                    hide-dropdown-icon
                    @create="addAllowedEmailDomain"
                    :placeholder="t(`admin.auth.allowedEmailDomainsPlaceholder`)"
                    :aria-label="t(`admin.auth.allowedEmailDomains`)" />
                </w-item-section>
              </w-item>
            </template>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.auth.strategyConfiguration') }}</w-card-header>
          <w-card-section>
            <w-banner
              class="mt-4"
              v-if="!state.strategy.config || Object.keys(state.strategy.config).length < 1"
              :class="dark.isActive ? `bg-dark-4 text-grey-5` : `bg-grey-2 text-grey-7`">
              <em>{{ t('admin.auth.noConfigOption') }}</em>
            </w-banner>
          </w-card-section>
          <!--
            Generic per-prop config form, shared with `AdminAnalytics.vue`, `AdminComments.vue`,
            `AdminSearch.vue` and `AdminStorage.vue` -- see `ModuleConfigForm.vue`.
            `state.strategy.config` is the `buildConfigEditor()`-built editable structure, not the
            raw stored values; mutating a field's `.value` there, which this component does in place,
            is what `buildConfigPayload()` in `payloadFor()` below reads back.
          -->
          <module-config-form v-if="state.strategy.config" :config="state.strategy.config" />
          <!--
            Not one of the dynamic `state.strategy.config` props above: `mappableGroups` is a
            top-level strategy field, same as `autoEnrollGroups`, gated on the module's own
            `mapGroups` boolean config prop rather than a `configIfCheck` (that check is written
            against sibling config props, not against another top-level field).
          -->
          <template v-if="state.strategy.config?.mapGroups?.value">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="team" />
              <w-item-section>
                <w-item-label>{{ t(`admin.auth.mappableGroups`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.auth.mappableGroupsHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-select
                  outlined
                  :options="state.groups"
                  v-model="state.strategy.mappableGroups"
                  multiple
                  map-options
                  emit-value
                  option-value="id"
                  option-label="name"
                  options-dense
                  dense
                  hide-bottom-space
                  :aria-label="t(`admin.auth.mappableGroups`)"
                  :loading="state.loadingGroups">
                  <template #selected>
                    <div class="text-caption" v-if="state.strategy.mappableGroups?.length > 1">
                      <i18n-t keypath="admin.users.groupsSelected">
                        <template #count>
                          <strong>{{ state.strategy.mappableGroups?.length }}</strong>
                        </template>
                      </i18n-t>
                    </div>
                    <div
                      class="text-caption"
                      v-else-if="state.strategy.mappableGroups?.length === 1">
                      <i18n-t keypath="admin.users.groupSelected">
                        <template #group
                          ><strong>{{ selectedMappableGroupName }}</strong></template
                        >
                      </i18n-t>
                    </div>
                    <span v-else />
                  </template>
                  <template #option="{ itemProps, opt, selected, toggleOption }">
                    <w-item v-bind="itemProps">
                      <w-item-section side>
                        <w-checkbox
                          :model-value="selected"
                          @update:model-value="toggleOption(opt)" />
                      </w-item-section>
                      <w-item-section
                        ><w-item-label>{{ opt.name }}</w-item-label></w-item-section
                      >
                    </w-item>
                  </template>
                </w-select>
              </w-item-section>
            </w-item>
            <w-item v-if="revocableMappableGroupNames.length > 0">
              <w-item-section>
                <w-banner
                  :class="
                    dark.isActive ? `bg-deep-orange text-white` : `bg-orange-1 text-deep-orange`
                  ">
                  <i18n-t keypath="admin.auth.mappableGroupsSyncWarning" tag="span">
                    <template #groups
                      ><strong>{{ revocableMappableGroupNames.join(', ') }}</strong></template
                    >
                  </i18n-t>
                </w-banner>
              </w-item-section>
            </w-item>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- References -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4" v-if="strategyRefs.length > 0">
          <w-card-header>
            {{ t('admin.auth.configReference') }}
            <template #hint>{{ t('admin.auth.configReferenceSubtitle') }}</template>
          </w-card-header>
          <w-item v-for="strRef of strategyRefs" :key="strRef.key">
            <blueprint-icon :icon="strRef.icon" :hue-rotate="-45" />
            <w-item-section>
              <w-item-label>{{ strRef.title }}</w-item-label>
              <w-item-label caption>{{ strRef.hint }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <!--
                These carry the strategy's ID, which the server assigns — so until Apply has created
                it there is no URL to register with the provider, and showing one built from the
                placeholder ID would be showing the wrong one.
              -->
              <w-item-label v-if="state.strategy.isNew" caption>
                {{ t('admin.auth.refAfterSave') }}
              </w-item-label>
              <w-input
                v-else
                outlined
                v-model="strRef.value"
                dense
                :aria-label="strRef.title"
                readonly />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Infobox -->
        <!-- ----------------------- -->
        <w-card class="mt-4">
          <w-card-section class="text-center">
            <!-- -> `mx-auto`: `text-center` on the section does nothing for a block-level image,
                 which sat against the left edge of every card wider than its 300px cap -->
            <img
              class="w-full mx-auto object-contain rounded"
              :src="state.strategy.strategy.logo"
              style="height: 100px; max-width: 300px"
              :alt="state.strategy.strategy.title" />
            <div class="text-subtitle2 mt-2">{{ state.strategy.strategy.title }}</div>
            <div class="text-caption mt-2">{{ state.strategy.strategy.description }}</div>
            <div class="text-caption mt-2">
              <strong>{{ state.strategy.strategy.vendor }}</strong>
            </div>
            <div class="text-caption">
              <a :href="state.strategy.strategy.website" target="_blank" rel="noreferrer">{{
                state.strategy.strategy.website
              }}</a>
            </div>
          </w-card-section>
        </w-card>
        <div class="flex mt-4">
          <div class="text-caption text-grey">ID: {{ state.strategy.id }}</div>
          <w-space />
          <w-btn
            class="acrylic-btn"
            icon="la:trash"
            flat
            color="negative"
            :disabled="isBuiltInLocal"
            :label="t(`admin.auth.deleteStrategy`)"
            @click="confirmDelete">
            <w-tooltip v-if="isBuiltInLocal">{{ t('admin.auth.deleteLocalForbidden') }}</w-tooltip>
          </w-btn>
        </div>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { v4 as uuid } from 'uuid'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm } from '@/composables/dialog'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'

import ModuleConfigForm from '@/components/ModuleConfigForm.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.auth.title')
}))

// CONSTANTS

// -> The strategy every account's password is stored against, hence the one that cannot be disabled
//    or deleted. A second instance of the local module is an ordinary strategy.
const BUILTIN_LOCAL_STRATEGY_ID = '5a528c4c-0a82-4ad2-96a5-2b23811e6588'

// DATA

const { state, load, refresh } = useAdminSettings({
  i18nPrefix: 'admin.auth',
  // -> Instance-wide, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    loadingGroups: true,
    groups: [],
    strategies: [],
    activeStrategies: [],
    // -> Strategy id -> number of sites currently showing it on their login screen (a missing key
    //    reads as zero) -- what `noVisibleSitesWarning` below reads (OpenProject #2557).
    visibleSiteCounts: {},
    selectedStrategy: '',
    // -> Text typed into the "Add Strategy" menu's filter field; reset each time the menu reopens
    strategyFilter: '',
    strategy: {
      strategy: {}
    }
  },
  fetch: async () => {
    state.loadingGroups = true
    try {
      return await Promise.all([
        API_CLIENT.get('authentication/modules').json(),
        API_CLIENT.get('authentication/strategies').json(),
        API_CLIENT.get('groups').json(),
        API_CLIENT.get('authentication/strategies/visible-site-counts').json()
      ])
    } finally {
      // -> Whether or not the request came back: the group picker must not be left spinning on a
      //    failure it is not the one reporting.
      state.loadingGroups = false
    }
  },
  onLoaded: ([modules, strategies, groups, visibleSiteCounts]) => {
    state.strategies = modules ?? []
    state.activeStrategies = (strategies ?? []).map((str) => {
      const mod = state.strategies.find((m) => m.key === str.module) ?? {
        key: str.module,
        title: str.module
      }
      return {
        ...str,
        strategy: mod,
        config: buildConfigEditor(mod.props, str.config)
      }
    })
    // -> Guests cannot be enrolled into, being the group of users who never logged in
    state.groups = (groups ?? []).filter((g) => g.id !== GUESTS_GROUP_ID)
    state.visibleSiteCounts = Object.fromEntries(
      (visibleSiteCounts ?? []).map((c) => [c.id, c.visibleSiteCount])
    )
  }
})

// REFS

const addStrategyMenuRef = ref(null)

// COMPUTED

const isBuiltInLocal = computed(() => {
  return state.strategy.id === BUILTIN_LOCAL_STRATEGY_ID
})
const availableStrategies = computed(() => {
  return state.strategies.filter((str) => str.key !== 'local')
})
/** `availableStrategies`, narrowed by `state.strategyFilter` as a case-insensitive title substring. */
const filteredAvailableStrategies = computed(() => {
  const filter = state.strategyFilter?.trim().toLowerCase()
  if (!filter) {
    return availableStrategies.value
  }
  return availableStrategies.value.filter((str) => str.title.toLowerCase().includes(filter))
})
const selectedGroupName = computed(() => {
  return state.groups.filter((g) => g.id === state.strategy?.autoEnrollGroups?.[0])[0]?.name
})
const selectedMappableGroupName = computed(() => {
  return state.groups.filter((g) => g.id === state.strategy?.mappableGroups?.[0])[0]?.name
})
/**
 * Names of the currently-selected mappable groups that `syncProviderGroups()` (`models/login.ts`)
 * would actually revoke on a login that stops reporting them -- i.e. every selected group except one
 * this same strategy also grants via `autoEnrollGroups`, which is never taken back regardless of the
 * allow-list (WP #2440: this screen selected these groups without ever calling out that risk).
 */
const revocableMappableGroupNames = computed(() => {
  const autoEnrolled = new Set(state.strategy?.autoEnrollGroups ?? [])
  return (state.strategy?.mappableGroups ?? [])
    .filter((id) => !autoEnrolled.has(id))
    .map((id) => state.groups.find((g) => g.id === id)?.name)
    .filter(Boolean)
})
/**
 * Whether the selected strategy is enabled but shown by no site's login screen -- covers a strategy
 * whose visibility was switched off on every site well after it was created, not only one that never
 * got a creation-time default (WP #2556 only seeds new strategies going forward). Never true for a
 * strategy this screen has not saved yet (`isNew`): no site can reference an id that does not exist
 * on the server, so the absence of any count for it would otherwise always read as a false positive
 * (OpenProject #2557).
 */
const noVisibleSitesWarning = computed(() => {
  const str = state.strategy
  if (!str?.id || str.isNew || !str.isEnabled) {
    return false
  }
  return (state.visibleSiteCounts[str.id] ?? 0) < 1
})
const strategyRefs = computed(() => {
  if (!state.selectedStrategy) {
    return []
  }
  const str = state.strategies.find((s) => s.key === state.strategy?.strategy?.key)
  if (!str?.refs) {
    return []
  }
  return Object.entries(str.refs).map(([key, ref]) => {
    return {
      ...ref,
      key,
      value: ref.value
        .replaceAll('{host}', window.location.origin)
        .replaceAll('{id}', state.selectedStrategy)
    }
  })
})

// WATCHERS

watch(
  () => state.selectedStrategy,
  (newValue) => {
    state.strategy = state.activeStrategies.find((str) => str.id === newValue) || { strategy: {} }
  }
)
watch(
  () => state.activeStrategies,
  (newValue) => {
    // -> Keep the current selection across a reload, falling back to the first strategy
    state.selectedStrategy = newValue.some((str) => str.id === state.selectedStrategy)
      ? state.selectedStrategy
      : newValue[0]?.id
    state.strategy = newValue.find((str) => str.id === state.selectedStrategy) || { strategy: {} }
  }
)

// METHODS

/** The strategy as the API expects it. */
function payloadFor(str) {
  return {
    displayName: str.displayName,
    isEnabled: str.isEnabled,
    selfRegistration: str.selfRegistration,
    autoProvision: str.autoProvision,
    allowedEmailRegex: str.allowedEmailRegex ?? '',
    allowedEmailDomains: str.allowedEmailDomains ?? [],
    autoEnrollGroups: str.autoEnrollGroups ?? [],
    trustEmailForLinking: str.trustEmailForLinking ?? false,
    mappableGroups: str.mappableGroups ?? [],
    config: buildConfigPayload(str.config)
  }
}

/**
 * Add whatever was typed into the allowed-domains field, as one domain or several.
 *
 * A comma, semicolon or whitespace separates domains, so a list can be pasted in one go -- same
 * convention as `PageTags.vue#createTag`. Normalization (trim/lower-case/dedupe) happens again on
 * the server (`models/authentication.ts`), which is what actually gets stored; this is only so the
 * field does not visibly hold mixed-case or duplicate entries between typing and saving.
 */
function addAllowedEmailDomain(val) {
  const domains = val
    .split(/[,;\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  if (domains.length === 0) {
    return
  }

  const current = state.strategy.allowedEmailDomains ?? []
  const next = current.slice()
  for (const domain of domains) {
    if (!next.includes(domain)) {
      next.push(domain)
    }
  }
  state.strategy.allowedEmailDomains = next
}

async function save() {
  if (state.loading > 0) {
    return
  }

  state.loading++
  const failures = []
  /*
    A strategy that has never been saved is created here, whole: the create endpoint takes the same
    fields the update one does, so a new provider arrives with its configuration rather than existing
    for a moment as an empty shell. Whichever ID the server assigns is what the reload below picks up.
  */
  for (const str of state.activeStrategies) {
    try {
      const resp = str.isNew
        ? await API_CLIENT.post('authentication/strategies', {
            json: { module: str.module, ...payloadFor(str) }
          }).json()
        : await API_CLIENT.put(`authentication/strategies/${str.id}`, {
            json: payloadFor(str)
          }).json()
      if (str.isNew && resp.id) {
        // -> So that the reload lands back on the strategy that was just created
        state.selectedStrategy = resp.id
      }
    } catch (err) {
      failures.push({ name: str.displayName, message: apiErrorMessage(err) })
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      notify({
        type: 'negative',
        message: t('admin.auth.saveFailed', { strategy: failure.name }),
        caption: failure.message
      })
    }
  } else {
    notify({
      type: 'positive',
      message: t('admin.auth.saveSuccess')
    })
  }
  state.loading--
  await load()
}

/**
 * Add a strategy to the list, without creating it.
 *
 * Nothing is sent: the new strategy is a row in this screen until Apply, like every edit made to the
 * ones beside it. An administrator adding a provider has a client ID and a secret to paste in first,
 * and a half-configured strategy that already exists on the server is one that can be saved by
 * accident, reloaded into, or left behind by closing the tab.
 *
 * The ID is a local placeholder; the server assigns the real one when this is created.
 */
function addStrategy(mod) {
  const strategy = {
    id: `new:${uuid()}`,
    isNew: true,
    module: mod.key,
    displayName: mod.title,
    // -> Off until it has been configured and saved: an enabled strategy appears on login screens
    isEnabled: false,
    selfRegistration: false,
    autoProvision: false,
    allowedEmailRegex: '',
    allowedEmailDomains: [],
    autoEnrollGroups: [],
    trustEmailForLinking: false,
    mappableGroups: [],
    strategy: mod,
    config: buildConfigEditor(mod.props, {})
  }
  state.activeStrategies.push(strategy)
  state.selectedStrategy = strategy.id
  state.strategy = strategy
  addStrategyMenuRef.value?.hide()
  notify({
    type: 'positive',
    message: t('admin.auth.addPending', { strategy: mod.title })
  })
}

function confirmDelete() {
  const strategy = state.strategy
  /*
    Nothing to confirm and nothing to delete for one that only ever existed here: it goes, and the
    selection falls back to the first strategy the way it does after a reload.
  */
  if (strategy.isNew) {
    state.activeStrategies = state.activeStrategies.filter((str) => str.id !== strategy.id)
    state.selectedStrategy = state.activeStrategies[0]?.id
    state.strategy = state.activeStrategies[0] ?? { strategy: {} }
    return
  }
  confirm({
    title: t('admin.auth.deleteStrategy'),
    message: t('admin.auth.deleteConfirm', { strategy: strategy.displayName }),
    persistent: true,
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.loading++
    try {
      await API_CLIENT.delete(`authentication/strategies/${strategy.id}`)
      notify({
        type: 'positive',
        message: t('admin.auth.deleteSuccess', { strategy: strategy.displayName })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.auth.deleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
    state.loading--
    await load()
  })
}
</script>
