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
          :disabled="!canEdit"
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
          :disabled="!canEdit"
          :aria-label="t(`profile.aesthetic`)"
          @update:model-value="onFieldChange('aesthetic', $event)" />
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
          :model-value="state.config.contentWidth"
          :options="contentWidths"
          :disabled="!canEdit"
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
          The virtual-scroll props the previous control took are gone: WSelect renders its options
          directly. The timezone list is the longest in the app and the dropdown scrolls internally,
          so this trades a few hundred DOM nodes for a much simpler component.
        -->
        <w-select
          ref="timezoneField"
          :model-value="state.config.timezone"
          :options="timezones"
          options-dense
          hide-bottom-space
          :aria-label="t(`admin.general.defaultTimezone`)"
          :readonly="!canEdit"
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
          :readonly="!canEdit"
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
          :disabled="!canEdit"
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
          :disabled="!canEdit"
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
  OpenProject #3315 (Feature #3314): split out of `ProfileInfo.vue`, which used to render THEME/TIME
  (as one combined "Preferences" section)/ACCESSIBILITY alongside the identity fields. Both pages now
  edit disjoint field subsets of the SAME `users/profile` record, so this page fetches and holds the
  *whole* profile -- mirroring `ProfileInfo.vue`'s own `applyProfile()`/`state.config` shape -- and
  `save()` PUTs the whole object back too. The identity fields below are carried through unmodified
  (this page renders no control for them), which is what keeps this page's auto-save from clobbering
  `ProfileInfo.vue`'s fields, and vice versa. Only one Profile section is ever mounted at a time
  (`ProfileOverlay.vue`'s `<component :is>`), so the two pages are never actually editing
  concurrently -- this shape guards the round-trip, not a live race between them.
*/

// STORES

const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.preferences')
}))

// DATA

const state = reactive({
  config: {
    // -> Carried through unmodified -- ProfileInfo.vue owns editing these, this page only round-trips
    //    them so its own save() does not clobber them.
    name: '',
    firstName: '',
    lastName: '',
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: '',
    dateFormat: '',
    timeFormat: '12h',
    // -> `null` rather than a hardcoded default, same reasoning as `ProfileInfo.vue` (OpenProject
    //    #3281): `WBtnToggle`'s selection check (`opt.value === modelValue`) is false for every
    //    segment when this is `null`, so nothing renders pre-selected until `applyProfile()` sets the
    //    real value. A failed fetch leaves these `null` on purpose -- the `profile.infoLoadingFailed`
    //    toast below is the signal, no silent fallback value here.
    aesthetic: null,
    appearance: null,
    contentWidth: null,
    cvd: null
  },
  loading: 0,
  // -> The only server error code this page can pin to a specific control -- see `applyFieldErrors`.
  fieldErrors: {
    timezone: null
  }
})

/*
  Task #3320 (Feature #3319): every field this page owns editing is a toggle or a select -- there is
  no intermediate "typing" state the way there is for a text field, so each one saves immediately on
  its own change event (`onFieldChange` below) rather than through a debounce. `ProfileInfo.vue`
  keeps a debounce of its own for the text fields it still owns; nothing here needs one, which is why
  this page carries no `debounce`/`AUTO_SAVE_DEBOUNCE_MS` of its own the way it used to before the
  split (OpenProject #3315) put only toggle/select controls on this page.
*/

const timezoneField = ref(null)

/*
  `WSelect` only re-runs its own `rules` on its own `modelValue` change or blur (see
  `fieldFrame.js`/`WInput.vue`) -- it does not fire just because `state.fieldErrors` changed out from
  under it, so every place that mutates it also calls this to force the field to re-read it
  immediately, rather than waiting for the reader to touch it again.
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

const canEdit = computed(() => siteStore.features?.profile)

// METHODS

/*
  Task #3320: every field on this page calls this directly from its own change event -- see the
  module-level comment above `timezoneField`.
*/
function onFieldChange(field, value) {
  state.config[field] = value
  if (suppressAutoSave || !canEdit.value) {
    return
  }
  save()
}

/**
 * The profile is read from the server rather than from the user store, same reasoning as
 * `ProfileInfo.vue`'s own `fetchProfile()`: the store only holds what the session carries, while the
 * rest of the record lives in the user's metadata and is not part of it.
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
  the post-save re-apply of the server's own echoed profile in `save()` -- and released only once Vue
  has flushed the reactive effects those assignments scheduled (`nextTick`). Without it, loading the
  profile (or a successful save re-syncing it) would itself look like an edit and queue another save.
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
  // -> No stored time zone means "whatever the browser resolves"
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
 * `userProfileInvalidTimezone` is the only server error code this page can pin to a specific
 * control -- `userProfileInvalidName` (the other one `ProfileInfo.vue` handles) can never fire from
 * a save originating here, since this page always carries the name fields through unmodified.
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
  OpenProject #3344: `onFieldChange()` (above) calls `save()` directly on every field change, with no
  debounce and nothing sequencing overlapping requests -- two fields changed in quick succession can
  have their PUT responses land out of order. `saveGeneration` is incremented on entry to `save()` and
  captured per call; the captured value is compared back against it before applying either branch's
  outcome, so a response whose `save()` call has since been superseded by a newer one -- on the
  success path OR the failure path -- is dropped rather than overwriting whatever the newer save
  already applied. `profileSaving.begin()`/`.end()` stay outside this guard (OpenProject #3282):
  they track requests in flight, not which response wins, so every call must run them regardless of
  whether its own response ends up applied or dropped as stale.
*/
let saveGeneration = 0

async function save() {
  clearFieldErrors()
  const generation = ++saveGeneration
  // -> OpenProject #3282: counted around the request so ProfileOverlay.vue's close button and
  //    MainOverlayDialog.vue's dismiss guard both see this save while it's in flight, even if the
  //    reader switches away from this section (which unmounts it) before it settles.
  profileSaving.begin()
  try {
    const resp = await API_CLIENT.put('users/profile', {
      json: {
        // -> Identity fields carried through unmodified -- see the module-level comment above.
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
        // -> No dedicated form control on either profile page: whatever `LocaleSelectorMenu`
        //    currently has the interface set to, persisted here so downstream per-user mail can
        //    address this user in it.
        locale: commonStore.locale
      }
    }).json()
    // -> OpenProject #3344: a newer save() has since started -- this response is stale, drop it
    //    rather than let it overwrite that newer call's own outcome.
    if (generation === saveGeneration) {
      if (resp.profile) {
        applyProfile(resp.profile)
      }
      // -> Only the fields this page owns editing -- the identity fields are ProfileInfo.vue's to
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
      // -> Task #3220/#3320: ambient auto-save -- no success toast.
    }
  } catch (err) {
    // -> OpenProject #3344: same stale-response guard as the success branch above -- a superseded
    //    failure gets neither the field-error pin nor the toast, since a newer save has already
    //    applied (or is about to apply) its own outcome over whatever this one would have shown.
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

// MOUNTED

onMounted(() => {
  fetchProfile()
})
</script>
