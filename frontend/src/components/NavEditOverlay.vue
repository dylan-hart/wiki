<template>
  <w-layout view="hHh lpR fFf" container>
    <w-header class="card-header px-4 py-2">
      <w-icon name="img:/_assets/icons/fluent-sidebar-menu.svg" left size="md" />
      <span>{{ t(`navEdit.editMenuItems`) }}</span>
      <!--
        Which menu is on screen, when it is not this page's own: an inherited menu is shared with every
        page that falls back to it, so a change here is not local to the page it was made from.
      -->
      <span class="ml-3 text-caption opacity-80" v-if="isEditingInherited">
        {{ t('navEdit.editingInherited') }}
      </span>
      <w-space />
      <transition name="syncing">
        <w-spinner class="mr-2" v-show="isBusy" color="accent" size="24px" />
      </transition>
      <w-btn
        class="mr-2"
        flat
        rounded
        color="white"
        :aria-label="t(`common.actions.viewDocs`)"
        icon="la:question-circle"
        :href="siteStore.docsBase + `/guide/navigation`"
        target="_blank">
        <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
      </w-btn>
      <w-btn-group push>
        <w-btn
          push
          color="white"
          text-color="grey-7"
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
          :disabled="isBusy"
          @click="save" />
      </w-btn-group>
    </w-header>
    <nav-item-editor
      ref="editorRef"
      :site-id="siteStore.id"
      :nav-id="navId"
      @load-error="close"
      @update:loading="state.editorLoading = $event" />
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
  return siteStore.overlayOpts.navId ?? (pageStore.isHome ? pageStore.navigationId : pageStore.id)
})

/** Whether the menu on screen is an inherited one, which is shared with every page using it. */
const isEditingInherited = computed(() => Boolean(siteStore.overlayOpts.navId))

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
        mode: siteStore.overlayOpts.mode ?? pageStore.navigationMode,
        items
      }
    }).json()
    // -> The API client does not throw on 400, so a refusal comes back as a parsed error
    if (resp?.ok === false) {
      throw new Error(resp.message || 'An unexpected error occured.')
    }
    notify({
      type: 'positive',
      message: t('navEdit.saveSuccess')
    })
    pageStore.$patch({
      navigationMode: resp.navigationMode,
      navigationId: resp.navigationId ?? null
    })
    // -> Redraw the sidebar from what was just saved, rather than waiting for a navigation
    await siteStore.fetchNavigation(resp.navigationId ?? navId.value)
    close()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, 'An unexpected error occured.')
    })
  }
  loading.hide()
  state.saving--
}

onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
</script>
