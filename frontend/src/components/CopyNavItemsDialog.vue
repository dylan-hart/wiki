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
 * Picks a menu to copy items FROM, for `NavItemEditor.vue`'s "Copy from..." action.
 *
 * A sibling of `LinkPickerDialog.vue`: self-contained, answering only `{ sourceSiteId, sourceNavId }`
 * and leaving the caller to actually run the copy (`POST .../navigation/:navId/copy`) and reload.
 *
 * `locales` and `otherSites` come in as props rather than being fetched here, because the host
 * (`NavItemEditor.vue`) already has to know both up front anyway -- to decide whether to show the
 * "Copy from..." action at all (hidden when there is nothing to copy from). Passing them down avoids
 * asking the server the same two questions twice. The one thing this dialog fetches for itself is a
 * DIFFERENT site's locale roots, once one is picked -- that list cannot be known ahead of time without
 * fetching it for every enabled site regardless of whether the admin ever chooses it.
 *
 *   dialog({ component: CopyNavItemsDialog, componentProps: { siteId, navId, locales, otherSites } })
 *     .onOk(({ sourceSiteId, sourceNavId }) => ...)
 */

// PROPS

const props = defineProps({
  /** The site of the menu being edited (the copy's target). */
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

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  otherSite: false,
  sourceSiteId: '',
  sourceLocale: '',
  /** This site's own roots, minus the menu being edited -- can never be a source for itself. */
  sameSiteLocales: props.locales.filter((r) => r.navigationId !== props.navId),
  /** Roots for whichever other site is currently picked, fetched on demand. */
  crossSiteLocales: [],
  isFetching: false
})

// COMPUTED

const localeOptions = computed(() =>
  state.otherSite ? state.crossSiteLocales : state.sameSiteLocales
)

const canSubmit = computed(() => {
  if (!state.sourceLocale) {
    return false
  }
  return state.otherSite ? Boolean(state.sourceSiteId) : true
})

// METHODS

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

// WATCHERS

watch(
  () => state.otherSite,
  (isOtherSite) => {
    if (isOtherSite) {
      if (state.sourceSiteId) {
        // -> Already set (re-toggling on with a site already picked) -- the `sourceSiteId` watcher
        //    below only fires on a CHANGE, so nothing would fetch without this
        loadCrossSiteLocales(state.sourceSiteId)
      } else {
        /*
          Not yet set when this is the FIRST time the toggle is switched on by hand (`onMounted` only
          pre-fills it for the "nothing same-site to offer" case below). Assignment alone is enough
          here -- it is what the `sourceSiteId` watcher below reacts to -- so this deliberately does
          NOT also call `loadCrossSiteLocales` itself: doing both would fire it twice for one toggle,
          and whichever response landed second would win, silently discarding the other.
        */
        state.sourceSiteId = props.otherSites[0]?.id ?? ''
      }
    } else {
      state.sourceLocale = state.sameSiteLocales[0]?.locale ?? ''
    }
  }
)

/** Re-fetched every time a different source site is picked, not just the first time. */
watch(
  () => state.sourceSiteId,
  (siteId) => {
    if (state.otherSite && siteId) {
      loadCrossSiteLocales(siteId)
    }
  }
)

// MOUNTED

onMounted(() => {
  /*
    Start on whichever branch actually has something to offer: a site with only one active locale
    (`sameSiteLocales` empty once its own row is excluded) but at least one other enabled site should
    not open onto an empty same-site select when the caller already knows to show this dialog only
    because the cross-site branch has options.
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
