<template>
  <w-layout container>
    <w-header class="card-header px-4 py-2">
      <w-icon name="img:/_assets/icons/fluent-sidebar-menu.svg" left size="md" />
      <span>{{ t(`navEdit.editMenuItems`) }}</span>
      <!--
        Which menu is on screen, when it is not this page's own: an inherited menu is shared with every
        page that falls back to it, so a change here is not local to the page it was made from.
      -->
      <span class="ms-3 text-caption opacity-80" v-if="isEditingInherited">
        {{ t('navEdit.editingInherited') }}
      </span>
      <span class="ms-3 text-caption opacity-80" v-if="menuMode === 'auto'">
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
        icon="la:question-circle"
        :href="siteStore.docsBase + `/guide/navigation`"
        target="_blank">
        <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
      </w-btn>
      <w-btn-group>
        <w-btn
          push
          color="white"
          text-color="text-secondary"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="la:times"
          @click="close" />
        <w-btn
          push
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          :aria-label="t(`common.actions.save`)"
          icon="la:check"
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

// PROPS

/**
 * Initial state from whoever opened this overlay (`NavEditMenu.vue`'s `siteStore.$patch({ overlay:
 * 'NavEdit', overlayOpts: {...} })`), forwarded here by `MainOverlayDialog.vue` (OpenProject #2530).
 * `navId`/`menuMode` below read this prop, not `siteStore.overlayOpts` directly.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * The per-page half of navigation editing, opened FROM a page (via `NavEditMenu.vue`'s mode picker,
 * itself opened from the page action menu) to edit THAT page's own `navigationMode` and menu — with
 * the ancestor menu it currently inherits (if any) resolved for it as `overlayOpts.navId` (the
 * `overlay-opts` prop from `MainOverlayDialog.vue`).
 * See `navId` and `isEditingInherited` below for how that resolution plays out, and `save()` for why
 * the mode has to travel with the items rather than being fixed by which menu is on screen.
 *
 * The site-wide counterpart is `AdminNavigation.vue`, which answers "where, across the whole site,
 * has someone already deviated from the default menu" and edits the site-wide default menu directly
 * — see its own header comment for the full split. Since Task 433 both surfaces host the same
 * `NavItemEditor.vue` for the actual item list/detail-panel editing, parameterized here by `navId`
 * (resolved below) rather than by page context, so a capability added to the item model itself needs
 * no duplicate work. What each host still owns separately is how the menu is addressed and how the
 * save is framed (mode-aware here vs. mode-agnostic in the admin dialog) — see `AdminNavigation.vue`
 * for why that half does NOT come for free between the two, and needs the equivalent decision made on
 * both sides whenever it changes.
 */

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  saving: 0,
  /** Mirrors `NavItemEditor`'s own `loading` via `@update:loading`, into `isBusy` below. */
  editorLoading: false
})

/** @type {import('vue').Ref<InstanceType<typeof NavItemEditor> | null>} */
const editorRef = ref(null)

// COMPUTED

/**
 * The menu being edited.
 *
 * `overlayOpts.navId` is a menu this page does not own: the one it inherits, resolved by the nav menu
 * that opened this editor, so that the sidebar a page shows can be edited from that page rather than
 * only from the ancestor holding it. Saving writes it back where it lives — see `save()`.
 *
 * Otherwise the page's own menu. The home page edits the site-wide menu — the one every other page
 * inherits — which is why it goes through its resolved id rather than its own. Any other page owns a
 * menu keyed by its own id, which the server creates on the first save.
 */
const navId = computed(() => {
  return props.overlayOpts.navId ?? (pageStore.isHome ? pageStore.navigationId : pageStore.id)
})

/** Whether the menu on screen is an inherited one, which is shared with every page using it. */
const isEditingInherited = computed(() => Boolean(props.overlayOpts.navId))

/**
 * The resolved menu's own source (`static`/`auto`/`mixed`) -- a different axis from the entry's own
 * cascade `mode`. Resolved by `NavEditMenu.vue`'s popup before this overlay ever opens (see its
 * `loadMenuMode`) and carried here via `overlayOpts`, rather than fetched again: it is what decides
 * whether `nav-item-editor` below renders read-only (`auto`), and it travels back out again on save so
 * that a source picked in the popup but not yet saved there is not silently lost.
 *
 * Left `undefined` (not defaulted to `'static'`) rather than assumed: `nav-item-editor` already
 * defaults its own `menuMode` prop to `'static'`, and an explicit `undefined` prop value falls through
 * to a component's own default exactly the same as the prop being omitted -- so this only ever adds
 * information, never overrides the editor's default with a guess of its own.
 */
const menuMode = computed(() => props.overlayOpts.menuMode)

/**
 * Loading the menu, loading the group list, or saving — any of which the header spinner covers and
 * the Save button disables against.
 *
 * `state.editorLoading` tracks via a plain `@update:loading` event rather than reading
 * `editorRef.value.loading` directly: a normal parent/child event, rather than a computed reaching
 * across the component boundary into another component's exposed state.
 */
const isBusy = computed(() => state.saving > 0 || state.editorLoading)

// METHODS

function close() {
  siteStore.$patch({ overlay: '' })
}

/**
 * `nav-item-editor`'s "Copy from..." action (OpenProject #1012) persists on its own, ahead of this
 * overlay's own Save button -- see `NavItemEditor.vue`'s `copied` event doc comment. Force-refetch
 * for the same reason `save()` below does: the id may not have changed even though its items did.
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
      The mode goes with the items, because the mode is what decides which menu they belong to: with
      `inherit` the server stores them against the menu this page inherits — the one shown on screen,
      and the one `navId` was resolved from — rather than starting a menu of this page's own that
      nothing would point at.
    */
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/navigation/pages/${pageStore.id}`, {
      json: {
        mode: props.overlayOpts.mode ?? pageStore.navigationMode,
        // -> Carried through unchanged (see `menuMode` above): the Save button is disabled while
        //    `auto`, so this only ever re-affirms whatever source was already resolved, or persists a
        //    source picked in the popup but not yet saved from there
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
    // -> Redraw the sidebar from what was just saved, rather than waiting for a navigation.
    //    `forceRefresh: true` (OpenProject #1012) because the id itself may not have changed even
    //    though its items just did -- `fetchNavigation()`'s own cache check would otherwise skip it.
    await siteStore.fetchNavigation(resp.navigationId ?? navId.value, true)
    close()
  } catch (err) {
    notify({
      type: 'negative',
      // -> `reconstructMenuItems()` (`helpers/navigation.js`) throws a plain error code, not a
      //    translated string, so it stays testable with no i18n context -- translate its one thrown
      //    code here, at the display boundary, same as every other message shown to the user.
      message:
        err.message === 'ERR_NESTED_LINK_WITHOUT_PARENT'
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
