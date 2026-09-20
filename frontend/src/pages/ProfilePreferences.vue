<template>
  <w-page>
    <h2 class="w-section-header">{{ t('profile.theme') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:sun" />
      <w-item-section>
        <w-item-label>{{ t(`profile.appearance`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.appearanceHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          :model-value="state.config.appearance"
          :options="appearances"
          :aria-label="t(`profile.appearance`)"
          @update:model-value="onFieldChange('appearance', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:layout-grid" />
      <w-item-section>
        <w-item-label>{{ t(`profile.aesthetic`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.aestheticHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          :model-value="state.config.aesthetic"
          :options="aesthetics"
          :aria-label="t(`profile.aesthetic`)"
          @update:model-value="onFieldChange('aesthetic', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:arrows-horizontal" />
      <w-item-section>
        <w-item-label>{{ t(`profile.contentWidth`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.contentWidthHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          :model-value="state.config.contentWidth"
          :options="contentWidths"
          :aria-label="t(`profile.contentWidth`)"
          @update:model-value="onFieldChange('contentWidth', $event)" />
      </w-item-section>
    </w-item>
    <h2 class="w-section-header">{{ t('profile.time') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:clock-hour-4" />
      <w-item-section>
        <w-item-label>{{ t(`profile.timezone`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.timezoneHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <!--
          The longest option list in the app, rendered whole: `WSelect` does not virtualise, and the
          dropdown scrolls internally -- a few hundred DOM nodes for a much simpler component.
        -->
        <w-select
          ref="timezoneField"
          :model-value="state.config.timezone"
          :options="timezones"
          options-dense
          hide-bottom-space
          :aria-label="t(`admin.general.defaultTimezone`)"
          :rules="[timezoneRule]"
          @update:model-value="onFieldChange('timezone', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:calendar" />
      <w-item-section>
        <w-item-label>{{ t(`profile.dateFormat`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.dateFormatHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-select
          :model-value="state.config.dateFormat"
          emit-value
          map-options
          hide-bottom-space
          :aria-label="t(`admin.general.defaultDateFormat`)"
          :options="dateFormats"
          @update:model-value="onFieldChange('dateFormat', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:clock" />
      <w-item-section>
        <w-item-label>{{ t(`profile.timeFormat`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.timeFormatHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          :model-value="state.config.timeFormat"
          :options="timeFormats"
          :aria-label="t(`profile.timeFormat`)"
          @update:model-value="onFieldChange('timeFormat', $event)" />
      </w-item-section>
    </w-item>
    <h2 class="w-section-header">{{ t('profile.accessibility') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:eye" />
      <w-item-section>
        <w-item-label>{{ t(`profile.cvd`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.cvdHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          :model-value="state.config.cvd"
          :options="cvdChoices"
          :aria-label="t(`profile.cvd`)"
          @update:model-value="onFieldChange('cvd', $event)" />
      </w-item-section>
    </w-item>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { profileSaving } from '@/composables/profileSaving'
import { apiErrorMessage } from '@/helpers/apiError'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'

import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/*
  This page and `ProfileInfo.vue` edit disjoint field subsets of the SAME `users/profile` record,
  and a save PUTs the whole object, so each holds the whole profile and carries the other's fields
  through unmodified. Only one Profile section is mounted at a time (`ProfileOverlay.vue`'s
  `<component :is>`), so this guards the round-trip, not a live race between the two.
*/

const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('profile.preferences')
}))

const state = reactive({
  config: {
    // -> Round-tripped only: `ProfileInfo.vue` owns editing these.
    name: '',
    firstName: '',
    lastName: '',
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: '',
    dateFormat: '',
    timeFormat: '12h',
    // -> `null`, not a hardcoded default: `WBtnToggle`'s selection check (`opt.value ===
    //    modelValue`) is false for every segment then, so nothing renders pre-selected and flashes
    //    across when `applyProfile()` lands. A failed fetch leaves them `null`; the toast is the
    //    signal, not a silent fallback value.
    aesthetic: null,
    appearance: null,
    contentWidth: null,
    cvd: null
  },
  loading: 0,
  fieldErrors: {
    timezone: null
  }
})

/*
  Every field here is a toggle or a select, with no intermediate "typing" state to wait out, so each
  saves immediately from its own change event and this page needs no debounce at all.
*/

const timezoneField = ref(null)

/*
  `WSelect` re-runs its `rules` only on its own `modelValue` change or blur, never because
  `state.fieldErrors` changed under it, so every writer of that object calls this to make the field
  re-read it instead of waiting for the reader to touch it again.
*/
function revalidateFieldRefs() {
  timezoneField.value?.validate()
}

const timezoneRule = () => state.fieldErrors.timezone ?? true

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
const aesthetics = [
  { value: 'site', label: t('profile.aestheticDefault') },
  { value: 'ledger', label: t('profile.aestheticLedger') },
  { value: 'cobalt', label: t('profile.aestheticCobalt') }
]
const appearances = [
  { value: 'site', label: t('profile.appearanceDefault') },
  { value: 'light', label: t('profile.appearanceLight') },
  { value: 'dark', label: t('profile.appearanceDark') }
]
const contentWidths = [
  { value: 'site', label: t('profile.contentWidthDefault') },
  { value: 'measured', label: t('profile.contentWidthMeasured') },
  { value: 'full', label: t('profile.contentWidthFull') }
]
const cvdChoices = [
  { value: 'none', label: t('profile.cvdNone') },
  { value: 'protanopia', label: t('profile.cvdProtanopia') },
  { value: 'deuteranopia', label: t('profile.cvdDeuteranopia') },
  { value: 'tritanopia', label: t('profile.cvdTritanopia') }
]
const timezones = Intl.supportedValuesOf('timeZone')

const identityEditable = computed(() => siteStore.features?.profile)

function onFieldChange(field, value) {
  state.config[field] = value
  if (suppressAutoSave) {
    return
  }
  save()
}

/**
 * Read from the server rather than from the user store: the store holds only what the session
 * carries, while the rest of the record lives in the user's metadata.
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

/*
  Without this, a programmatic rewrite of `state.config` -- the initial load, or re-applying the
  profile a save echoed back -- would look like an edit and fire another save. Released only after
  `nextTick`, once the reactive effects those assignments scheduled have flushed.
*/
let suppressAutoSave = true

function applyProfile(profile) {
  suppressAutoSave = true
  state.config.name = profile.name || ''
  state.config.firstName = profile.firstName || ''
  state.config.lastName = profile.lastName || ''
  state.config.location = profile.location || ''
  state.config.jobTitle = profile.jobTitle || ''
  state.config.pronouns = profile.pronouns || ''
  state.config.timezone = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  state.config.dateFormat = profile.dateFormat || ''
  state.config.timeFormat = profile.timeFormat || '12h'
  state.config.aesthetic = profile.aesthetic || 'site'
  state.config.appearance = profile.appearance || 'site'
  state.config.contentWidth = profile.contentWidth || 'site'
  state.config.cvd = profile.cvd || 'none'
  nextTick(() => {
    suppressAutoSave = false
  })
}

/**
 * `userProfileInvalidTimezone` is the only failure this page can pin to a control: the name fields
 * it carries through unmodified cannot be rejected by a save originating here.
 */
function applyFieldErrors(err) {
  const code = err?.data?.error
  if (code === 'userProfileInvalidTimezone') {
    state.fieldErrors.timezone = apiErrorMessage(err, t('common.error.unexpected'))
  }
  revalidateFieldRefs()
}

function clearFieldErrors() {
  for (const key of Object.keys(state.fieldErrors)) {
    state.fieldErrors[key] = null
  }
  revalidateFieldRefs()
}

/*
  Two rapid `onFieldChange` calls each send their own PUT and nothing sequences the two responses,
  so the older one could land last and overwrite `state.config` through `applyProfile()` or pin a
  stale field error. A response -- success or failure -- is applied only while no newer `save()` has
  started since. `profileSaving.begin()`/`.end()` stay outside the guard: they track requests in
  flight, not which response wins.
*/
let saveGeneration = 0

async function save() {
  clearFieldErrors()
  const generation = ++saveGeneration
  // -> Counted on the shared module singleton, not locally: `ProfileOverlay.vue`'s close button and
  //    `MainOverlayDialog.vue`'s dismiss guard must still see this save if the reader switches away
  //    from the section -- which unmounts it -- before it settles.
  profileSaving.begin()
  try {
    const resp = await API_CLIENT.put('users/profile', {
      json: {
        ...(identityEditable.value
          ? {
              name: state.config.name,
              firstName: state.config.firstName,
              lastName: state.config.lastName,
              location: state.config.location,
              jobTitle: state.config.jobTitle,
              pronouns: state.config.pronouns
            }
          : {}),
        timezone: state.config.timezone,
        dateFormat: state.config.dateFormat,
        timeFormat: state.config.timeFormat,
        aesthetic: state.config.aesthetic,
        appearance: state.config.appearance,
        contentWidth: state.config.contentWidth,
        cvd: state.config.cvd,
        // -> No form control of its own: `LocaleSelectorMenu` owns picking the UI language, and
        //    saving records whatever it is set to as this user's mail preference.
        locale: commonStore.locale
      }
    }).json()
    // -> Dropped outright once a newer save has started, rather than clobbering what that one has
    //    already applied.
    if (generation === saveGeneration) {
      if (resp.profile) {
        applyProfile(resp.profile)
      }
      // -> Only the fields this page owns editing; the identity fields are `ProfileInfo.vue`'s to
      //    patch onto the store.
      userStore.$patch({
        timezone: state.config.timezone,
        dateFormat: state.config.dateFormat,
        timeFormat: state.config.timeFormat,
        aesthetic: state.config.aesthetic,
        appearance: state.config.appearance,
        contentWidth: state.config.contentWidth,
        cvd: state.config.cvd
      })
      // -> No success toast: the auto-save is ambient.
    }
  } catch (err) {
    // -> Same guard as the success branch: a superseded failure gets neither the field-error pin
    //    nor the toast, since a newer save has already applied its own outcome.
    if (generation === saveGeneration) {
      applyFieldErrors(err)
      notify({
        type: 'negative',
        message: t('profile.saveFailed'),
        caption: apiErrorMessage(err, t('common.error.unexpected'))
      })
    }
  }
  profileSaving.end()
}

onMounted(() => {
  fetchProfile()
})
</script>
