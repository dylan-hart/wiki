<template>
  <w-card style="min-width: 350px">
    <w-card-section class="card-header">
      <w-icon name="tabler:layout-sidebar" left size="sm" />
      <span>{{ t(`navEdit.title`) }}</span>
    </w-card-section>
    <w-list padding>
      <template v-if="isRoot">
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="inherit" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeShow') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeShowHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="hide" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeHide') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeHideHint') }}</w-item-label>
          </w-item-section>
        </w-item>
      </template>
      <template v-else>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="inherit" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeInherit') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeInheritHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="override" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeOverride') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeOverrideHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="overrideExact" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeOverrideExact') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeOverrideExactHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="hide" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeHideDescendants') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeHideDescendantsHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.mode" val="hideExact" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.modeHideExact') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.modeHideExactHint') }}</w-item-label>
          </w-item-section>
        </w-item>
      </template>
    </w-list>
    <template v-if="canEditMenuItems">
      <w-separator inset />
      <w-list padding>
        <w-item-label class="text-caption" header>{{ t('navEdit.menuSourceLabel') }}</w-item-label>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.menuMode" val="static" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.menuSourceStatic') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.menuSourceStaticHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.menuMode" val="auto" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.menuSourceAuto') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.menuSourceAutoHint') }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item tag="label">
          <w-item-section side><w-radio v-model="state.menuMode" val="mixed" /></w-item-section>
          <w-item-section>
            <w-item-label>{{ t('navEdit.menuSourceMixed') }}</w-item-label>
            <w-item-label caption>{{ t('navEdit.menuSourceMixedHint') }}</w-item-label>
          </w-item-section>
        </w-item>
      </w-list>
      <w-separator inset />
      <w-card-section>
        <w-btn
          class="w-full"
          icon="mdi:playlist-edit"
          color="deep-orange-9"
          :label="t(`navEdit.editMenuItems`)"
          @click="startEditing" />
      </w-card-section>
    </template>
    <w-card-actions class="card-actions">
      <w-space />
      <w-btn
        class="acrylic-btn"
        flat
        :label="t(`common.actions.cancel`)"
        color="grey"
        padding="xs md"
        @click="props.menuHideHandler" />
      <w-btn
        :label="t(`common.actions.save`)"
        color="positive"
        padding="xs md"
        @click="save"
        :loading="state.loading > 0" />
    </w-card-actions>
  </w-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  menuHideHandler: {
    type: Function,
    default: () => ({})
  },
  updatePositionHandler: {
    type: Function,
    default: () => ({})
  }
})

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  mode: 'inherit',
  /**
   * The menu this page inherits, resolved on open for any page that is not the root — see the
   * `inherited` endpoint.
   *
   * Asked of the server rather than read off `pageStore.navigationId`, which only answers this while
   * the SAVED mode is `inherit`: on a page that currently overrides, picking Inherit here has to point
   * at the ancestor's menu, and the ancestor holding it is not something the page knows.
   *
   * Null means nothing to inherit: the sidebar above this page is hidden.
   */
  inheritedNavId: null,
  /**
   * The target menu row's own source (`static`/`auto`/`mixed`) -- a different axis from `mode` above,
   * which is this ENTRY's cascade setting. Loaded from the currently-resolved menu (`pageStore.navigationId`)
   * on open, via `loadMenuMode`, and saved alongside `mode` as `menuMode` -- see `save()` and
   * `updateNavigation`'s own doc comment for why the two travel separately.
   */
  menuMode: 'static',
  loading: 0
})

// COMPUTED

const isRoot = computed(() => {
  return pageStore.path === '' || pageStore.path === 'home'
})

const canEditMenuItems = computed(() => {
  // -> Inheriting edits the menu this page shows where it lives, which needs there to be one
  if (!isRoot.value && state.mode === 'inherit') {
    return Boolean(state.inheritedNavId)
  }
  return ['inherit', 'override', 'overrideExact'].includes(state.mode)
})

// WATCHERS

watch(
  () => state.mode,
  () => {
    nextTick(() => {
      props.updatePositionHandler()
    })
  }
)

// METHODS

/**
 * Resolves the menu this page inherits, so that Inherit can offer to edit it.
 *
 * Quiet on failure: the mode itself is what this menu is for and can still be set, so a resolution
 * that did not come back only leaves the Edit Menu Items button out.
 */
async function loadInheritedNav() {
  // -> Deliberately outside `state.loading`, which is what the Save button spins on: this runs as the
  //    menu opens, and a spinner there would read as a save in flight
  try {
    const resp = await API_CLIENT.get(
      `sites/${siteStore.id}/navigation/pages/${pageStore.id}/inherited`
    ).json()
    state.inheritedNavId = resp?.navigationId ?? null
    // -> A row appearing under the list makes the menu taller than the popup it was measured for
    nextTick(() => {
      props.updatePositionHandler()
    })
  } catch (err) {
    console.warn(`Could not resolve the inherited navigation menu: ${apiErrorMessage(err)}`)
  }
}

/**
 * Resolves the currently-resolved menu's own source mode, to preselect the Menu Source selector.
 *
 * `pageStore.navigationId` is already the right target regardless of this entry's own cascade mode --
 * inheriting or owning, it is the menu this page currently shows, set by the server on every mode
 * change. Skipped entirely when there is none (`hide`/`hideExact`), and quiet on failure like
 * `loadInheritedNav`: the cascade mode is still usable even if this one call did not come back.
 */
async function loadMenuMode() {
  if (!pageStore.navigationId) {
    return
  }
  try {
    const resp = await API_CLIENT.get(
      `sites/${siteStore.id}/navigation/${pageStore.navigationId}/mode`
    ).json()
    state.menuMode = resp?.mode ?? 'static'
  } catch (err) {
    console.warn(`Could not resolve the menu's source mode: ${apiErrorMessage(err)}`)
  }
}

function startEditing() {
  siteStore.$patch({
    overlay: 'NavEdit',
    overlayOpts: {
      mode: state.mode,
      menuMode: state.menuMode,
      // -> A menu this page does not own: only Inherit edits one, and only away from the root, where
      //    inheriting and owning are the same menu. See NavEditOverlay's `navId`.
      ...(!isRoot.value && state.mode === 'inherit' && { navId: state.inheritedNavId })
    }
  })
  props.menuHideHandler()
}

async function save() {
  state.loading++
  try {
    // -> The menu items themselves are what the overlay saves; this popup only ever saves the two
    //    modes -- the entry's cascade (`mode`) and the resolved menu's own source (`menuMode`)
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/navigation/pages/${pageStore.id}`, {
      json: { mode: state.mode, menuMode: state.menuMode }
    }).json()
    notify({
      type: 'positive',
      message: t('navEdit.saveModeSuccess')
    })
    pageStore.$patch({
      navigationMode: state.mode,
      navigationId: resp.navigationId ?? null
    })
    /*
      Force-refetch rather than relying on the `pageStore.navigationId` watcher `NavSidebar.vue` runs
      (OpenProject #1012's fix, same as `NavEditOverlay.vue`'s own `save()`): that watcher only fires
      when the id itself changes, but plenty of saves from THIS popup leave it unchanged while still
      changing what the sidebar should show -- `menuMode` alone (`static`/`auto`/`mixed`, resolved
      against the SAME row), or `override` <-> `overrideExact` (both resolve to this entry's own row,
      per `updateNavigation()`). Left to the watcher, none of those redraw the sidebar until a full
      reload re-fetches from scratch -- this is the "still reproduces" gap the item editor's own Save
      button already closed but this popup's Save never did.
    */
    await siteStore.fetchNavigation(resp.navigationId ?? null, true)
    props.menuHideHandler()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  state.mode = pageStore.navigationMode
  loadMenuMode()
  if (!isRoot.value) {
    loadInheritedNav()
  }
})
</script>
