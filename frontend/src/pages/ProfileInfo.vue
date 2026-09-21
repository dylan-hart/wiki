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
          :rules="[firstNameRule]"
          @blur="commitTextField('firstName')"
          @keyup:enter="commitTextField('firstName')"
          @keydown.esc="revertTextField('firstName', $event)" />
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
          :rules="[lastNameRule]"
          @blur="commitTextField('lastName')"
          @keyup:enter="commitTextField('lastName')"
          @keydown.esc="revertTextField('lastName', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <!--
      Derived from the two halves above, but shown rather than hidden so the override is reachable:
      typing anything else authors the display name for good, and typing back exactly what the
      halves derive to hands it back to derivation.
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
          :rules="[nameRule]"
          @blur="commitTextField('name')"
          @keyup:enter="commitTextField('name')"
          @keydown.esc="revertTextField('name', $event)" />
      </w-item-section>
    </w-item>
    <w-separator inset />
    <w-item>
      <blueprint-icon icon="tabler:hash" />
      <w-item-section>
        <w-item-label>{{ t(`profile.handle`) }}</w-item-label>
        <w-item-label caption>{{ t(`profile.handleHint`) }}</w-item-label>
      </w-item-section>
      <w-item-section>
        <w-input
          ref="handleField"
          v-model="state.config.handle"
          hide-bottom-space
          prefix="@"
          :aria-label="t(`profile.handle`)"
          :readonly="!canEdit"
          :rules="[handleRule]"
          @blur="commitTextField('handle')"
          @keyup:enter="commitTextField('handle')"
          @keydown.esc="revertTextField('handle', $event)" />
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
          :readonly="!canEdit"
          @blur="commitTextField('location')"
          @keyup:enter="commitTextField('location')"
          @keydown.esc="revertTextField('location', $event)" />
        <profile-visibility-toggle
          field="location"
          :field-label="t(`profile.location`)"
          :model-value="isPublic('location')"
          :forced="isForced('location')"
          :disabled="!canEdit"
          @update:model-value="setPublic('location', $event)" />
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
          :readonly="!canEdit"
          @blur="commitTextField('jobTitle')"
          @keyup:enter="commitTextField('jobTitle')"
          @keydown.esc="revertTextField('jobTitle', $event)" />
        <profile-visibility-toggle
          field="jobTitle"
          :field-label="t(`profile.jobTitle`)"
          :model-value="isPublic('jobTitle')"
          :forced="isForced('jobTitle')"
          :disabled="!canEdit"
          @update:model-value="setPublic('jobTitle', $event)" />
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
          :readonly="!canEdit"
          @blur="commitTextField('pronouns')"
          @keyup:enter="commitTextField('pronouns')"
          @keydown.esc="revertTextField('pronouns', $event)" />
        <profile-visibility-toggle
          field="pronouns"
          :field-label="t(`profile.pronouns`)"
          :model-value="isPublic('pronouns')"
          :forced="isForced('pronouns')"
          :disabled="!canEdit"
          @update:model-value="setPublic('pronouns', $event)" />
      </w-item-section>
    </w-item>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { debounce } from 'es-toolkit/function'

import ProfileVisibilityToggle from '@/components/ProfileVisibilityToggle.vue'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { profileSaving } from '@/composables/profileSaving'
import { apiErrorMessage } from '@/helpers/apiError'
import { useDerivedDisplayName } from '@/composables/displayName'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('profile.myInfo')
}))

const state = reactive({
  config: {
    name: '',
    firstName: '',
    lastName: '',
    handle: '',
    email: '',
    location: '',
    jobTitle: '',
    pronouns: '',
    publicFields: [],
    forcedPublicFields: [],
    timezone: '',
    dateFormat: '',
    timeFormat: '12h',
    // -> `null`, not a guessed default: this page renders no control for these four and only
    //    carries them through, so an unfetched value must stay visibly unset. `fetchProfile()`'s
    //    toast is the only signal a failed load gets.
    aesthetic: null,
    appearance: null,
    contentWidth: null,
    cvd: null
  },
  loading: 0,
  fieldErrors: {
    name: null,
    firstName: null,
    lastName: null,
    handle: null
  }
})

// -> What Esc reverts to: `state.config` only ever holds the in-progress edit, so this parallel
//    record holds what the server last confirmed. Written only once a fetch or save response lands.
const TEXT_FIELDS = ['firstName', 'lastName', 'name', 'handle', 'location', 'jobTitle', 'pronouns']
const lastSaved = reactive({
  firstName: '',
  lastName: '',
  name: '',
  handle: '',
  location: '',
  jobTitle: '',
  pronouns: ''
})

function snapshotTextFields() {
  for (const field of TEXT_FIELDS) {
    lastSaved[field] = state.config[field]
  }
}

// -> Deliberately longer than the ~350-400ms this codebase uses for a typeahead: there is no
//    dropdown of results to react to, so a reader gets a real pause before a request goes out.
const AUTO_SAVE_DEBOUNCE_MS = 800

const firstNameField = ref(null)
const lastNameField = ref(null)
const nameField = ref(null)
const handleField = ref(null)

/*
  `WInput` re-runs its `rules` only on its own `modelValue` change or blur, never because
  `state.fieldErrors` changed under it, so every writer of that object calls this to make the
  affected control re-read it instead of waiting for the reader to touch the field again.
*/
function revalidateFieldRefs() {
  firstNameField.value?.validate()
  lastNameField.value?.validate()
  nameField.value?.validate()
  handleField.value?.validate()
}

const firstNameRule = () => state.fieldErrors.firstName ?? true
const lastNameRule = () => state.fieldErrors.lastName ?? true
const nameRule = () => state.fieldErrors.name ?? true
const handleRule = () => state.fieldErrors.handle ?? true

const canEdit = computed(() => siteStore.features?.profile)

// Keep in sync with `PROFILE_PUBLIC_FIELDS` in `backend/models/users.ts`.
const PUBLIC_FIELD_KEYS = ['location', 'jobTitle', 'pronouns']

function knownPublicFields(list) {
  return Array.isArray(list) ? PUBLIC_FIELD_KEYS.filter((key) => list.includes(key)) : []
}

const isPublic = (field) => state.config.publicFields.includes(field)
const isForced = (field) => state.config.forcedPublicFields.includes(field)

function setPublic(field, on) {
  if (isForced(field)) {
    return
  }
  state.config.publicFields = knownPublicFields(
    on
      ? [...state.config.publicFields, field]
      : state.config.publicFields.filter((f) => f !== field)
  )
}

// -> Without this, editing a half alone leaves a stale `name` in the payload, which the server
//    reads as a deliberate override and freezes the display name for good.
const { syncFromStored: syncDisplayName } = useDerivedDisplayName(() => state.config)

/**
 * Read from the server rather than from the user store: the store holds only what the session
 * carries, while location / job title / pronouns live in the user's metadata.
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
  profile a save echoed back -- would look like an edit and queue another save. Released only after
  `nextTick`, which is when the watcher's own job for those same assignments would have run.
*/
let suppressAutoSave = true

function applyProfile(profile) {
  suppressAutoSave = true
  state.config.name = profile.name || ''
  state.config.firstName = profile.firstName || ''
  state.config.lastName = profile.lastName || ''
  state.config.handle = profile.handle || ''
  state.config.email = profile.email || ''
  state.config.location = profile.location || ''
  state.config.jobTitle = profile.jobTitle || ''
  state.config.pronouns = profile.pronouns || ''
  state.config.publicFields = knownPublicFields(profile.publicFields)
  state.config.forcedPublicFields = knownPublicFields(profile.forcedPublicFields)
  state.config.timezone = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  state.config.dateFormat = profile.dateFormat || ''
  state.config.timeFormat = profile.timeFormat || '12h'
  state.config.aesthetic = profile.aesthetic || 'site'
  state.config.appearance = profile.appearance || 'site'
  state.config.contentWidth = profile.contentWidth || 'site'
  state.config.cvd = profile.cvd || 'none'
  // -> After the whole record is in the fields, not per-field: the answer depends on all three.
  syncDisplayName()
  // -> After derivation has had its say on `name`: this is what Esc reverts to.
  snapshotTextFields()
  nextTick(() => {
    suppressAutoSave = false
  })
}

/**
 * `userProfileInvalidName` is the one failure this page can pin to controls, and it covers all
 * three name fields at once because the server validates them together. Every other failure is
 * reported by `save()`'s toast alone.
 */
function applyFieldErrors(err) {
  const code = err?.data?.error
  const message = apiErrorMessage(err, t('common.error.unexpected'))
  if (code === 'userProfileInvalidName') {
    state.fieldErrors.name = message
    state.fieldErrors.firstName = message
    state.fieldErrors.lastName = message
  } else if (code === 'userHandleTaken' || code === 'userHandleInvalid') {
    state.fieldErrors.handle = message
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
  // -> Counted on the shared module singleton, not locally: `ProfileOverlay.vue`'s close button and
  //    `MainOverlayDialog.vue`'s dismiss guard must still see this save if the reader switches away
  //    from the section -- which unmounts it -- before it settles.
  profileSaving.begin()
  try {
    // -> No `email` in the payload: it is read-only on this screen.
    const resp = await API_CLIENT.put('users/profile', {
      json: {
        // -> Sent even when derived: the server reads a `name` equal to what the halves derive to
        //    as "keep deriving", so submitting the form authors nobody's display name by itself.
        name: state.config.name,
        firstName: state.config.firstName,
        lastName: state.config.lastName,
        handle: state.config.handle,
        location: state.config.location,
        jobTitle: state.config.jobTitle,
        pronouns: state.config.pronouns,
        // -> The reader's own list only, never the forced one merged in: un-forcing a field later
        //    must reveal their own choice.
        publicFields: state.config.publicFields,
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
    if (resp.profile) {
      applyProfile(resp.profile)
    }
    // -> Only the field this page owns editing; the theme/time/accessibility fields are
    //    `ProfilePreferences.vue`'s to patch onto the store.
    userStore.$patch({
      name: state.config.name
    })
    // -> No success toast: the auto-save is ambient. The failure path below still raises one.
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

/**
 * A discrete commit on blur or Enter, not the debounced auto-save the toggle/select fields use.
 * The unchanged-value skip is also what makes an Esc-then-blur a no-op rather than a redundant
 * round-trip: `revertTextField` writes the old value back before blurring, so the two already match.
 */
function commitTextField(field) {
  if (!canEdit.value) {
    return
  }
  if (state.config[field] === lastSaved[field]) {
    return
  }
  save()
}

/**
 * The explicit `blur()` is what makes Esc a *cancel* rather than a revert the reader could type
 * back over; it re-enters `commitTextField` through the field's own `@blur`, which no-ops now that
 * the values match.
 *
 * `stopPropagation()` keeps this first Escape from also closing the dialog: this target-phase
 * handler runs before the event reaches `composables/escapeStack.js`'s bubble-phase listener on
 * `document`, which would otherwise dismiss the Profile overlay in the same keypress. A second
 * Escape -- the field now blurred, so this never runs -- bubbles normally and closes it.
 */
function revertTextField(field, event) {
  state.config[field] = lastSaved[field]
  event.target.blur()
  event.stopPropagation()
}

const debouncedAutoSave = debounce(save, AUTO_SAVE_DEBOUNCE_MS)

/*
  The toggle/select fields only: the text fields commit through `commitTextField` on blur/Enter, and
  watching them here too would queue a debounced save alongside each discrete one. A new field of
  either kind belongs in this list or in `TEXT_FIELDS`, not both.
*/
watch(
  () => [
    state.config.aesthetic,
    state.config.appearance,
    state.config.contentWidth,
    state.config.cvd,
    state.config.publicFields.join(','),
    state.config.timezone,
    state.config.dateFormat,
    state.config.timeFormat
  ],
  () => {
    if (suppressAutoSave || !canEdit.value) {
      return
    }
    debouncedAutoSave()
  }
)

onMounted(() => {
  fetchProfile()
})

// -> An uncancelled debounce would fire ~800ms after the reader has navigated away.
onUnmounted(() => {
  debouncedAutoSave.cancel()
})
</script>
