<template>
  <w-page>
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
    <h2 class="w-section-header">{{ t('profile.preferences') }}</h2>
    <w-item>
      <blueprint-icon icon="tabler:sun" />
      <w-item-section>
        <w-item-label>{{ t(`profile.appearance`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.appearanceHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          v-model="state.config.appearance"
          :options="appearances"
          :disabled="!canEdit"
          :aria-label="t(`profile.appearance`)" />
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
          v-model="state.config.aesthetic"
          :options="aesthetics"
          :disabled="!canEdit"
          :aria-label="t(`profile.aesthetic`)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <!-- -> Feature #3051 / Task #3068: per-user override of the site's `contentWidth` admin setting. -->
    <w-item>
      <blueprint-icon icon="tabler:arrows-horizontal" />
      <w-item-section>
        <w-item-label>{{ t(`profile.contentWidth`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.contentWidthHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-btn-toggle
          v-model="state.config.contentWidth"
          :options="contentWidths"
          :disabled="!canEdit"
          :aria-label="t(`profile.contentWidth`)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
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
          ref="timezoneField"
          v-model="state.config.timezone"
          :options="timezones"
          options-dense
          hide-bottom-space
          :aria-label="t(`admin.general.defaultTimezone`)"
          :readonly="!canEdit"
          :rules="[timezoneRule]" />
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
          v-model="state.config.dateFormat"
          emit-value
          map-options
          hide-bottom-space
          :aria-label="t(`admin.general.defaultDateFormat`)"
          :options="dateFormats"
          :readonly="!canEdit" />
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
          v-model="state.config.timeFormat"
          :options="timeFormats"
          :disabled="!canEdit"
          :aria-label="t(`profile.timeFormat`)" />
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
          v-model="state.config.cvd"
          :options="cvdChoices"
          :disabled="!canEdit"
          :aria-label="t(`profile.cvd`)" />
      </w-item-section>
    </w-item>
    <h1 class="w-section-header">{{ t('profile.myInfo') }}</h1>
    <w-item>
      <blueprint-icon icon="tabler:user" />
      <w-item-section>
        <w-item-label>{{ t(`profile.firstName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.firstNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          ref="firstNameField"
          v-model="state.config.firstName"
          hide-bottom-space
          :aria-label="t(`profile.firstName`)"
          :readonly="!canEdit"
          :rules="[firstNameRule]" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:user" />
      <w-item-section>
        <w-item-label>{{ t(`profile.lastName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.lastNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          ref="lastNameField"
          v-model="state.config.lastName"
          hide-bottom-space
          :aria-label="t(`profile.lastName`)"
          :readonly="!canEdit"
          :rules="[lastNameRule]" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <!--
      The display name is derived from the two halves above on every save, and shown here rather
      than hidden so the override Feature #2608 grants is actually reachable: typing something
      else authors it, and the server then leaves it alone through later half edits. Typing back
      exactly what the halves derive to hands it back to derivation.
    -->
    <w-item>
      <blueprint-icon icon="tabler:id" />
      <w-item-section>
        <w-item-label>{{ t(`profile.displayName`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.displayNameHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          ref="nameField"
          v-model="state.config.name"
          hide-bottom-space
          :aria-label="t(`profile.displayName`)"
          :readonly="!canEdit"
          :rules="[nameRule]" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:mail" />
      <w-item-section>
        <w-item-label>{{ t(`profile.email`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.emailHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.email"
          monospaced
          :aria-label="t(`profile.email`)"
          readonly />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:map-pin" />
      <w-item-section>
        <w-item-label>{{ t(`profile.location`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.locationHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.location"
          hide-bottom-space
          :aria-label="t(`profile.location`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:briefcase" />
      <w-item-section>
        <w-item-label>{{ t(`profile.jobTitle`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.jobTitleHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.jobTitle"
          hide-bottom-space
          :aria-label="t(`profile.jobTitle`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:gender-bigender" />
      <w-item-section>
        <w-item-label>{{ t(`profile.pronouns`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.pronounsHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          v-model="state.config.pronouns"
          hide-bottom-space
          :aria-label="t(`profile.pronouns`)"
          :readonly="!canEdit" />
      </w-item-section>
    </w-item>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { debounce } from 'es-toolkit/function'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { profileSaving } from '@/composables/profileSaving'
import { apiErrorMessage } from '@/helpers/apiError'
import { useDerivedDisplayName } from '@/composables/displayName'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

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
    aesthetic: 'site',
    appearance: 'site',
    contentWidth: 'site',
    cvd: 'none'
  },
  loading: 0,
  /*
    The only two server error codes (`userProfileInvalidName`, `userProfileInvalidTimezone`) that
    name a specific field -- see `applyFieldErrors` below. Every other failure is reported only by
    the toast in `save()`'s catch.
  */
  fieldErrors: {
    name: null,
    firstName: null,
    lastName: null,
    timezone: null
  }
})

/*
  Task #3220: auto-save is ambient, so its debounce has to run per keystroke rather than per
  explicit click -- 800ms gives a reader a real pause to keep typing before a request goes out,
  longer than the ~350-400ms this codebase uses for a typeahead search (there is nothing to react to
  as fast as a dropdown of results here).
*/
const AUTO_SAVE_DEBOUNCE_MS = 800

const firstNameField = ref(null)
const lastNameField = ref(null)
const nameField = ref(null)
const timezoneField = ref(null)

/*
  `WInput`/`WSelect` only re-run their own `rules` on their own `modelValue` change or blur (see
  `fieldFrame.js`/`WInput.vue`) -- neither fires just because `state.fieldErrors` changed out from
  under them, so every place that mutates it also calls this to force the affected control to
  re-read it immediately, rather than waiting for the reader to touch the field again.
*/
function revalidateFieldRefs() {
  firstNameField.value?.validate()
  lastNameField.value?.validate()
  nameField.value?.validate()
  timezoneField.value?.validate()
}

const firstNameRule = () => state.fieldErrors.firstName ?? true
const lastNameRule = () => state.fieldErrors.lastName ?? true
const nameRule = () => state.fieldErrors.name ?? true
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

/*
  Set for the duration of every programmatic rewrite of `state.config` -- the initial load below and
  the post-save re-apply of the server's own echoed profile in `save()` -- and released only once
  Vue has flushed the reactive effects those assignments scheduled (`nextTick`), which is also when
  the auto-save watcher's own job for this same change would run. Without it, loading the profile
  (or a successful save re-syncing it) would itself look like an edit and queue another save.
*/
let suppressAutoSave = true

function applyProfile(profile) {
  suppressAutoSave = true
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
  state.config.aesthetic = profile.aesthetic || 'site'
  state.config.appearance = profile.appearance || 'site'
  state.config.contentWidth = profile.contentWidth || 'site'
  state.config.cvd = profile.cvd || 'none'
  // -> After the whole record is in the fields, not per-field: the answer depends on all three.
  syncDisplayName()
  nextTick(() => {
    suppressAutoSave = false
  })
}

/**
 * Maps the one kind of failure the server can pin to a specific control onto `state.fieldErrors`,
 * so the affected field carries its own inline error alongside the toast `save()`'s catch always
 * raises. `userProfileInvalidName` covers all three name fields at once (the server validates them
 * together); everything else -- including a validation failure with no dedicated error code -- is
 * reported by the toast alone.
 */
function applyFieldErrors(err) {
  const code = err?.data?.error
  const message = apiErrorMessage(err, t('common.error.unexpected'))
  if (code === 'userProfileInvalidName') {
    state.fieldErrors.name = message
    state.fieldErrors.firstName = message
    state.fieldErrors.lastName = message
  } else if (code === 'userProfileInvalidTimezone') {
    state.fieldErrors.timezone = message
  }
  revalidateFieldRefs()
}

function clearFieldErrors() {
  for (const key of Object.keys(state.fieldErrors)) {
    state.fieldErrors[key] = null
  }
  revalidateFieldRefs()
}

async function save() {
  clearFieldErrors()
  // -> OpenProject #3282: counted around the request so ProfileOverlay.vue's close button and
  //    MainOverlayDialog.vue's dismiss guard both see this save while it's in flight, even if the
  //    reader switches away from this section (which unmounts it) before it settles.
  profileSaving.begin()
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
        aesthetic: state.config.aesthetic,
        appearance: state.config.appearance,
        contentWidth: state.config.contentWidth,
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
      aesthetic: state.config.aesthetic,
      appearance: state.config.appearance,
      contentWidth: state.config.contentWidth,
      cvd: state.config.cvd
    })
    // -> Task #3220: ambient auto-save -- no success toast. The point is removing the need to
    //    think about saving at all; a failure below still surfaces one, so nothing is silently lost.
  } catch (err) {
    applyFieldErrors(err)
    notify({
      type: 'negative',
      message: t('profile.saveFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  profileSaving.end()
}

const debouncedAutoSave = debounce(save, AUTO_SAVE_DEBOUNCE_MS)

/*
  Watches the whole config object rather than any one field, so this keeps working whichever fields
  a later change adds or however they get reordered in the template -- see Task #3220/#3221's
  coordination note. `applyProfile()` is the only other writer of `state.config`, and it guards
  itself with `suppressAutoSave`.
*/
watch(
  () => state.config,
  () => {
    if (suppressAutoSave || !canEdit.value) {
      return
    }
    debouncedAutoSave()
  },
  { deep: true }
)

// MOUNTED

onMounted(() => {
  fetchProfile()
})

// -> A pending debounced auto-save left uncancelled would otherwise fire ~800ms after the reader
//    has already navigated away from this page, same reasoning `EditorMarkdown.vue` cancels its own
//    debounced writes on unmount for (OpenProject #808).
onUnmounted(() => {
  debouncedAutoSave.cancel()
})
</script>
