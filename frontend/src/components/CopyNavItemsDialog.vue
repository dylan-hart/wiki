<template>
  <w-dialog v-model="dialogVisible" :aria-label="t('navEdit.copyFrom')" @hide="onDialogHide">
    <w-card style="width: 480px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:file-import" size="sm" class="me-2" />
        <span>{{ t('navEdit.copyFrom') }}</span>
      </w-card-section>
      <w-card-section class="text-body2 text-grey-8">
        {{ t('navEdit.copyFromInfoText') }}
      </w-card-section>
      <w-separator />
      <w-item v-if="props.otherSites.length > 0" tag="label">
        <blueprint-icon icon="tabler:server" />
        <w-item-section>
          <w-item-label>{{ t('navEdit.copyFromOtherSite') }}</w-item-label>
        </w-item-section>
        <w-item-section avatar>
          <w-toggle v-model="state.otherSite" :aria-label="t('navEdit.copyFromOtherSite')" />
        </w-item-section>
      </w-item>
      <w-item v-if="state.otherSite">
        <blueprint-icon icon="tabler:server" />
        <w-item-section>
          <w-item-label>{{ t('navEdit.sourceSite') }}</w-item-label>
          <w-item-label caption>{{ t('navEdit.sourceSiteHint') }}</w-item-label>
        </w-item-section>
        <w-item-section>
          <w-select
            dense
            hide-bottom-space
            v-model="state.sourceSiteId"
            :options="props.otherSites"
            option-value="id"
            option-label="title"
            emit-value
            map-options
            :aria-label="t('navEdit.sourceSite')" />
        </w-item-section>
      </w-item>
      <w-item>
        <blueprint-icon icon="tabler:language" />
        <w-item-section>
          <w-item-label>{{ t('navEdit.sourceLocale') }}</w-item-label>
          <w-item-label caption>{{ t('navEdit.sourceLocaleHint') }}</w-item-label>
        </w-item-section>
        <w-item-section>
          <w-select
            dense
            hide-bottom-space
            :loading="state.isFetching"
            :disabled="localeOptions.length < 1"
            v-model="state.sourceLocale"
            :options="localeOptions"
            option-value="locale"
            option-label="locale"
            emit-value
            map-options
            :aria-label="t('navEdit.sourceLocale')" />
        </w-item-section>
      </w-item>
      <w-separator />
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:x"
          :label="t('common.actions.cancel')"
          color="grey-7"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          icon="tabler:check"
          :label="t('common.actions.copy')"
          color="primary"
          padding="xs md"
          :disabled="!canSubmit"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'

/**
 * Self-contained: it answers only `{ sourceSiteId, sourceNavId }`, leaving the caller to run the
 * copy and reload.
 *
 * `locales` and `otherSites` come in as props rather than being fetched here, because the host
 * (`NavItemEditor.vue`) already has to know both to decide whether to offer this action at all. The
 * one thing this dialog fetches for itself is a DIFFERENT site's locale roots, once one is picked --
 * that list cannot be known ahead of time without fetching it for every enabled site.
 */

const props = defineProps({
  /** The site of the menu being edited -- the copy's target. */
  siteId: {
    type: String,
    required: true
  },
  /** The row id of the menu being edited -- excluded from the same-site locale list below. */
  navId: {
    type: String,
    required: true
  },
  /** `{ locale, navigationId }[]` -- this site's own default-menu roots, one per active locale. */
  locales: {
    type: Array,
    default: () => []
  },
  /** `{ id, title, hostname }[]` -- other enabled sites, excluding this one. */
  otherSites: {
    type: Array,
    default: () => []
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
  otherSite: false,
  sourceSiteId: '',
  sourceLocale: '',
  /** Minus the menu being edited -- it can never be a source for itself. */
  sameSiteLocales: props.locales.filter((r) => r.navigationId !== props.navId),
  crossSiteLocales: [],
  isFetching: false
})

const localeOptions = computed(() =>
  state.otherSite ? state.crossSiteLocales : state.sameSiteLocales
)

const canSubmit = computed(() => {
  if (!state.sourceLocale) {
    return false
  }
  return state.otherSite ? Boolean(state.sourceSiteId) : true
})

async function loadCrossSiteLocales(siteId) {
  state.isFetching = true
  state.crossSiteLocales = []
  state.sourceLocale = ''
  try {
    const roots = await API_CLIENT.get(`sites/${siteId}/navigation/roots`).json()
    state.crossSiteLocales = roots ?? []
    state.sourceLocale = state.crossSiteLocales[0]?.locale ?? ''
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.isFetching = false
}

function submit() {
  const match = localeOptions.value.find((r) => r.locale === state.sourceLocale)
  if (!match) {
    return
  }
  onDialogOK({
    sourceSiteId: state.otherSite ? state.sourceSiteId : props.siteId,
    sourceNavId: match.navigationId
  })
}

watch(
  () => state.otherSite,
  (isOtherSite) => {
    if (isOtherSite) {
      if (state.sourceSiteId) {
        // -> Re-toggling on with a site already picked: the `sourceSiteId` watcher below fires only
        //    on a CHANGE, so nothing would fetch without this
        loadCrossSiteLocales(state.sourceSiteId)
      } else {
        /*
          The assignment alone is enough -- it is what the `sourceSiteId` watcher below reacts to --
          so this deliberately does NOT also call `loadCrossSiteLocales`: doing both would fire it
          twice for one toggle, and whichever response landed second would win.
        */
        state.sourceSiteId = props.otherSites[0]?.id ?? ''
      }
    } else {
      state.sourceLocale = state.sameSiteLocales[0]?.locale ?? ''
    }
  }
)

watch(
  () => state.sourceSiteId,
  (siteId) => {
    if (state.otherSite && siteId) {
      loadCrossSiteLocales(siteId)
    }
  }
)

onMounted(() => {
  /*
    Start on whichever branch actually has something to offer: with `sameSiteLocales` empty once the
    menu's own row is excluded, opening onto the same-site select would show nothing at all.
  */
  if (state.sameSiteLocales.length > 0) {
    state.sourceLocale = state.sameSiteLocales[0].locale
  } else if (props.otherSites.length > 0) {
    // -> Setting `sourceSiteId` before `otherSite` means the `otherSite` watcher's own fetch fires
    //    with a real id already in place, rather than needing a second assignment here to trigger it
    state.sourceSiteId = props.otherSites[0].id
    state.otherSite = true
  }
})
</script>
