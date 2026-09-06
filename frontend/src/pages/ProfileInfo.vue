<template>
  <w-page class="py-4">
    <h1 class="w-section-header">{{ t('profile.myInfo') }}</h1>
    <w-item v-if="!canEdit">
      <w-item-section>
        <w-card class="bg-negative rounded text-white">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="shrink-0 pe-0">
              <w-icon name="tabler:ban" size="lg" />
            </w-card-section>
            <w-card-section>
              <span>{{ t('profile.editDisabledTitle') }}</span>
              <div class="text-caption text-red-1">{{ t('profile.editDisabledDescription') }}</div>
            </w-card-section>
          </w-card-section>
        </w-card>
      </w-item-section>
    </w-item>
    <w-item>
      <blueprint-icon icon="tabler:user" />
      <w-item-section>
        <w-item-label>{{ t(`profile.firstName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.firstNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.firstName"
          dense
          hide-bottom-space
          :aria-label="t(`profile.firstName`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:user" />
      <w-item-section>
        <w-item-label>{{ t(`profile.lastName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.lastNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.lastName"
          dense
          hide-bottom-space
          :aria-label="t(`profile.lastName`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <!--
      The display name is derived from the two halves above on every save, and shown here rather
      than hidden so the override Feature #2608 grants is actually reachable: typing something
      else authors it, and the server then leaves it alone through later half edits. Typing back
      exactly what the halves derive to hands it back to derivation.
    -->
    <w-item>
      <blueprint-icon icon="tabler:address-book" />
      <w-item-section>
        <w-item-label>{{ t(`profile.displayName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.displayNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.name"
          dense
          hide-bottom-space
          :aria-label="t(`profile.displayName`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:mail" />
      <w-item-section>
        <w-item-label>{{ t(`profile.email`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.emailHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input v-model="state.config.email" dense :aria-label="t(`profile.email`)" readonly />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:map-pin" />
      <w-item-section>
        <w-item-label>{{ t(`profile.location`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.locationHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.location"
          dense
          hide-bottom-space
          :aria-label="t(`profile.location`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:briefcase" />
      <w-item-section>
        <w-item-label>{{ t(`profile.jobTitle`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.jobTitleHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.jobTitle"
          dense
          hide-bottom-space
          :aria-label="t(`profile.jobTitle`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:gender-bigender" />
      <w-item-section>
        <w-item-label>{{ t(`profile.pronouns`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.pronounsHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.pronouns"
          dense
          hide-bottom-space
          :aria-label="t(`profile.pronouns`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <h2 class="w-section-header mt-6">{{ t('profile.preferences') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:clock-hour-4" />
      <w-item-section>
        <w-item-label>{{ t(`profile.timezone`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.timezoneHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <!--
          The virtual-scroll props the previous control took are gone: WSelect renders its options
          directly. The timezone list is the longest in the app and the dropdown scrolls internally,
          so this trades a few hundred DOM nodes for a much simpler component.
        -->
        <w-select
          v-model="state.config.timezone"
          :options="timezones"
          dense
          options-dense
          hide-bottom-space
          :aria-label="t(`admin.general.defaultTimezone`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:calendar" />
      <w-item-section>
        <w-item-label>{{ t(`profile.dateFormat`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.dateFormatHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-select
          v-model="state.config.dateFormat"
          emit-value
          map-options
          dense
          hide-bottom-space
          :aria-label="t(`admin.general.defaultDateFormat`)"
          :options="dateFormats"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:clock" />
      <w-item-section>
        <w-item-label>{{ t(`profile.timeFormat`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.timeFormatHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section side>
        <w-btn-toggle
          v-model="state.config.timeFormat"
          toggle-color="primary"
          :options="timeFormats"
          :disabled="!canEdit"
          :aria-label="t(`profile.timeFormat`)" />
      </w-item-section>
    </w-item>
    <w-separator inset spaced="sm" />
    <w-item>
      <blueprint-icon icon="tabler:bulb" />
      <w-item-section>
        <w-item-label>{{ t(`profile.appearance`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.appearanceHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section side>
        <w-btn-toggle
          v-model="state.config.appearance"
          toggle-color="primary"
          :options="appearances"
          :disabled="!canEdit"
          :aria-label="t(`profile.appearance`)" />
      </w-item-section>
    </w-item>
    <h2 class="w-section-header mt-6">{{ t('profile.accessibility') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:eye-off" />
      <w-item-section>
        <w-item-label>{{ t(`profile.cvd`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.cvdHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section side>
        <w-btn-toggle
          v-model="state.config.cvd"
          toggle-color="primary"
          :options="cvdChoices"
          :disabled="!canEdit"
          :aria-label="t(`profile.cvd`)" />
      </w-item-section>
    </w-item>
    <div v-if="canEdit" class="actions-bar mt-6">
      <w-btn
        icon="tabler:check"
        :label="t(`common.actions.saveChanges`)"
        color="slate"
        :disabled="state.loading > 0"
        @click="save" />
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { apiErrorMessage } from '@/helpers/apiError'
import { useDerivedDisplayName } from '@/composables/displayName'
import { computed, onMounted, reactive } from 'vue'

import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.myInfo')
}))

// DATA

const state = reactive({
  config: {
    name: '',
    firstName: '',
    lastName: '',
    email: '',
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: '',
    dateFormat: '',
    timeFormat: '12h',
    appearance: 'site',
    cvd: 'none'
  },
  loading: 0
})

const dateFormats = [
  { value: '', label: t('profile.localeDefault') },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
  { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD' }
]
const timeFormats = [
  { value: '12h', label: t('admin.general.defaultTimeFormat12h') },
  { value: '24h', label: t('admin.general.defaultTimeFormat24h') }
]
const appearances = [
  { value: 'site', label: t('profile.appearanceDefault') },
  { value: 'light', label: t('profile.appearanceLight') },
  { value: 'dark', label: t('profile.appearanceDark') }
]
const cvdChoices = [
  { value: 'none', label: t('profile.cvdNone') },
  { value: 'protanopia', label: t('profile.cvdProtanopia') },
  { value: 'deuteranopia', label: t('profile.cvdDeuteranopia') },
  { value: 'tritanopia', label: t('profile.cvdTritanopia') }
]
const timezones = Intl.supportedValuesOf('timeZone')

const canEdit = computed(() => siteStore.features?.profile)

/*
  Keeps the display name in step with the two halves until the reader overrides it. Without it,
  editing a half alone would leave a stale `name` in the payload -- which the server reads as a
  deliberate override and would freeze the display name for good. See the composable's own doc.
*/
const { syncFromStored: syncDisplayName } = useDerivedDisplayName(() => state.config)

// METHODS

/**
 * The profile is read from the server rather than from the user store: the store only holds what the
 * session carries (name, email, preferences), while the location / job title / pronouns live in the
 * user's metadata and are not part of it.
 */
async function fetchProfile() {
  state.loading++
  try {
    const profile = await API_CLIENT.get('users/profile').json()
    applyProfile(profile)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.infoLoadingFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

function applyProfile(profile) {
  state.config.name = profile.name || ''
  state.config.firstName = profile.firstName || ''
  state.config.lastName = profile.lastName || ''
  state.config.email = profile.email || ''
  state.config.location = profile.location || ''
  state.config.jobTitle = profile.jobTitle || ''
  state.config.pronouns = profile.pronouns || ''
  // -> No stored time zone means "whatever the browser resolves"
  state.config.timezone = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  state.config.dateFormat = profile.dateFormat || ''
  state.config.timeFormat = profile.timeFormat || '12h'
  state.config.appearance = profile.appearance || 'site'
  state.config.cvd = profile.cvd || 'none'
  // -> After the whole record is in the fields, not per-field: the answer depends on all three.
  syncDisplayName()
}

async function save() {
  loading.show({
    message: t('profile.saving')
  })
  try {
    // -> The email is displayed read-only and cannot be changed here, so it is left out entirely.
    //    `locale` has no field of its own on this screen -- it is whatever the app's own locale
    //    switcher (`LocaleSelectorMenu`) currently has the interface set to, persisted here so
    //    downstream per-user mail can address this user in it.
    const resp = await API_CLIENT.put('users/profile', {
      json: {
        // -> All three are sent every time. The server owns the derive-unless-authored rule
        //    (`models/users.ts#updateUser`) and treats a `name` equal to what the halves derive to
        //    as "keep deriving", so submitting the whole form does not silently author every
        //    account it touches -- which is why nothing here tracks whether the field was typed in.
        name: state.config.name,
        firstName: state.config.firstName,
        lastName: state.config.lastName,
        location: state.config.location,
        jobTitle: state.config.jobTitle,
        pronouns: state.config.pronouns,
        timezone: state.config.timezone,
        dateFormat: state.config.dateFormat,
        timeFormat: state.config.timeFormat,
        appearance: state.config.appearance,
        cvd: state.config.cvd,
        // -> No dedicated form control: `LocaleSelectorMenu` already owns picking the UI language,
        //    so saving the profile records whatever that's currently set to as the mail preference.
        locale: commonStore.locale
      }
    }).json()
    if (resp.profile) {
      applyProfile(resp.profile)
    }
    // -> Only the fields the store actually holds: the appearance and CVD choices are watched by the
    //    app shell, so saving them takes effect right away
    userStore.$patch({
      name: state.config.name,
      timezone: state.config.timezone,
      dateFormat: state.config.dateFormat,
      timeFormat: state.config.timeFormat,
      appearance: state.config.appearance,
      cvd: state.config.cvd
    })
    notify({
      type: 'positive',
      message: t('profile.saveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.saveFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  loading.hide()
}

// MOUNTED

onMounted(() => {
  fetchProfile()
})
</script>
