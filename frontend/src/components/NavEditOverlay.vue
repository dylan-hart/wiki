<template>
  <w-layout container>
    <w-header class="card-header nav-edit-header">
      <w-icon name="tabler:layout-sidebar" left size="md" />
      <span>{{ t(`navEdit.editMenuItems`) }}</span>
      <!--
        An inherited menu is shared with every page that falls back to it, so a change made here is
        not local to the page it was made from.
      -->
      <span class="nav-edit-header-notice ms-3" v-if="isEditingInherited">
        <w-icon name="tabler:info-circle" size="12px" />
        {{ t('navEdit.editingInherited') }}
      </span>
      <span class="nav-edit-header-notice ms-3" v-if="menuMode === 'auto'">
        {{ t('navEdit.menuSourceReadOnlyNotice') }}
      </span>
      <w-space />
      <transition name="syncing">
        <w-spinner class="me-2" v-show="isBusy" color="accent" size="24px" />
      </transition>
      <w-btn
        class="me-2"
        flat
        rounded
        color="white"
        :aria-label="t(`common.actions.viewDocs`)"
        icon="tabler:help-circle"
        :href="siteStore.docsBase + `/guide/navigation`"
        target="_blank">
        <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
      </w-btn>
      <w-btn-group class="nav-edit-header-actions">
        <w-btn
          class="nav-edit-cancel-btn"
          color="white"
          text-color="slate"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="tabler:x"
          @click="close" />
        <w-btn
          class="nav-edit-save-btn"
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          :aria-label="t(`common.actions.save`)"
          icon="tabler:check"
          :disabled="isBusy || menuMode === 'auto'"
          @click="save" />
      </w-btn-group>
    </w-header>
    <nav-item-editor
      ref="editorRef"
      :site-id="siteStore.id"
      :nav-id="navId"
      :menu-mode="menuMode"
      @load-error="close"
      @update:loading="state.editorLoading = $event"
      @copied="onCopied" />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, reactive, ref } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { apiErrorMessage } from '@/helpers/apiError'
import NavItemEditor from '@/components/NavItemEditor.vue'

/**
 * Initial state from whoever opened this overlay, forwarded here by `MainOverlayDialog.vue`.
 * `navId`/`menuMode` below read this prop, not `siteStore.overlayOpts` directly.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * The per-page half of navigation editing, opened FROM a page to edit THAT page's own
 * `navigationMode` and menu; `AdminNavigation.vue` is the site-wide counterpart. Both host the same
 * `NavItemEditor.vue`, parameterized by `navId` rather than by page context -- what each owns
 * separately is how the menu is addressed and how the save is framed (mode-aware here,
 * mode-agnostic in the admin dialog), so a change to that half needs the equivalent decision made
 * on both sides.
 */

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  saving: 0,
  editorLoading: false
})

/** @type {import('vue').Ref<InstanceType<typeof NavItemEditor> | null>} */
const editorRef = ref(null)

/**
 * `overlayOpts.navId` is a menu this page does not own: the one it inherits, resolved by the nav
 * menu that opened this editor, so the sidebar a page shows can be edited from that page rather
 * than only from the ancestor holding it.
 *
 * Otherwise the page's own menu. The home page edits the site-wide menu — the one every other page
 * inherits — which is why it goes through its resolved id rather than its own. Any other page owns
 * a menu keyed by its own id, which the server creates on the first save.
 */
const navId = computed(() => {
  return props.overlayOpts.navId ?? (pageStore.isHome ? pageStore.navigationId : pageStore.id)
})

const isEditingInherited = computed(() => Boolean(props.overlayOpts.navId))

/**
 * The resolved menu's own source (`static`/`auto`/`mixed`) -- a different axis from the entry's own
 * cascade `mode`. Carried in via `overlayOpts` rather than fetched again, and sent back out on save
 * so that a source picked in the popup but not yet saved there is not silently lost.
 *
 * Left `undefined` rather than defaulted to `'static'`: an explicit `undefined` prop falls through
 * to `nav-item-editor`'s own default exactly as omitting it would, so this only ever adds
 * information, never overrides that default with a guess of its own.
 */
const menuMode = computed(() => props.overlayOpts.menuMode)

/**
 * `state.editorLoading` tracks via a plain `@update:loading` event rather than reading
 * `editorRef.value.loading` directly: a normal parent/child event, rather than a computed reaching
 * across the component boundary into another component's exposed state.
 */
const isBusy = computed(() => state.saving > 0 || state.editorLoading)

function close() {
  siteStore.$patch({ overlay: '' })
}

/**
 * `nav-item-editor`'s "Copy from..." action persists on its own, ahead of this overlay's own Save
 * button. Force-refetch for the same reason `save()` below does: the id may not have changed even
 * though its items did.
 */
async function onCopied() {
  await siteStore.fetchNavigation(navId.value, true)
}

async function save() {
  state.saving++
  loading.show()
  try {
    const items = editorRef.value.buildSaveItems()

    /*
      The mode travels with the items because it is what decides which menu they belong to: under
      `inherit` the server stores them against the menu this page inherits — the one on screen —
      rather than starting a menu of this page's own that nothing would point at.
    */
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/navigation/pages/${pageStore.id}`, {
      json: {
        mode: props.overlayOpts.mode ?? pageStore.navigationMode,
        menuMode: menuMode.value,
        items
      }
    }).json()
    notify({
      type: 'positive',
      message: t('navEdit.saveSuccess')
    })
    pageStore.$patch({
      navigationMode: resp.navigationMode,
      navigationId: resp.navigationId ?? null
    })
    // -> `forceRefresh: true` because the id itself may not have changed even though its items
    //    just did -- `fetchNavigation()`'s own cache check would otherwise skip the refetch.
    await siteStore.fetchNavigation(resp.navigationId ?? navId.value, true)
    close()
  } catch (err) {
    // -> `reconstructMenuItems()` throws a plain error code rather than a translated string, so it
    //    stays testable with no i18n context -- translated here, at the display boundary.
    const isNestedLinkError = err.message === 'ERR_NESTED_LINK_WITHOUT_PARENT'
    notify({
      type: 'negative',
      message: isNestedLinkError
        ? t('navEdit.nestedItemWithoutParent')
        : apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  loading.hide()
  state.saving--
}

onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
</script>

<style scoped>
/*
  Fixed dark-header text/border tones regardless of the site's own light/dark theme: this band never
  leaves `var(--color-dark-2)`, so there is nothing here for a `body--dark` variant to do.
*/
.nav-edit-header-notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--color-text-secondary);
  color: var(--color-text-dark);
  font-size: 11.5px;
  white-space: nowrap;
}

/*
  Scoped to this component's own `.nav-edit-header` rather than the shared `.card-header` class,
  which every other full-bleed overlay still uses.
*/
:global(body.body--cobalt .nav-edit-header) {
  background-color: var(--color-admin-sidebar-raised);
  border-bottom-color: var(--color-admin-sidebar-raised);
}

:global(body.body--cobalt .nav-edit-header-notice) {
  border: 0;
  border-radius: var(--radius-pill);
  padding: 3px 10px;
  background-color: rgb(255 255 255 / 0.12);
  color: var(--color-sidebar-text);
}

/*
  `overflow: hidden` clips the two buttons' own square corners to the group's rounded ones, leaving
  `WBtnGroup`'s own scoped divider rule untouched for every other caller.
*/
:global(body.body--cobalt .nav-edit-header-actions) {
  overflow: hidden;
  border-radius: var(--radius-control);
}

/*
  `text-color="slate"` resolves to the generic, non-aesthetic `var(--color-slate)`, which `WBtn`
  sets as an inline style, so only `!important` overrides it from outside. Cobalt has no "slate
  button" token yet -- `--color-text-secondary` is the nearest existing one.
*/
:global(body.body--cobalt .nav-edit-cancel-btn) {
  color: var(--color-text-secondary) !important;
}

/*
  `color="positive"` resolves to the generic, non-aesthetic `var(--color-positive)`, also inline --
  same `!important` reasoning as Cancel above. `--color-positive-fill` is the Cobalt-scoped token
  this button wants.
*/
:global(body.body--cobalt .nav-edit-save-btn) {
  background-color: var(--color-positive-fill) !important;
}
</style>
