<template>
  <w-layout class="inbox-overlay" container>
    <w-header class="card-header px-4 py-2">
      <w-icon name="mdi:inbox-full" left size="md" />
      <span>{{ t('inbox.title') }}</span>
      <w-space />
      <w-btn-group>
        <w-btn
          push
          color="white"
          text-color="grey-7"
          :label="t('common.actions.close')"
          :aria-label="t('common.actions.close')"
          icon="la:times"
          @click="close" />
      </w-btn-group>
    </w-header>

    <w-drawer class="inbox-overlay-sidebar" :model-value="true" :width="260">
      <w-scroll-area style="height: 100%">
        <div class="pt-2">
          <w-list>
            <w-item
              v-for="navItem of sidenav"
              :key="navItem.key"
              clickable
              :class="{ 'is-active': tab === navItem.key }"
              @click="tab = navItem.key">
              <w-item-section side>
                <w-icon :name="navItem.icon" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ navItem.label }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </div>
      </w-scroll-area>
    </w-drawer>

    <w-page-container>
      <inbox-watching v-if="tab === 'watching'" />
      <inbox-review
        v-else
        :initial-submission-id="overlayOpts.submissionId ?? null"
        :from-page="overlayOpts.from === 'page'" />
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '@/stores/site'

import InboxReview from '@/pages/InboxReview.vue'
import InboxWatching from '@/pages/InboxWatching.vue'

/**
 * The inbox: what has come in for this user, what they are following, and what is waiting on them.
 *
 * A `MainOverlayDialog` entry (OpenProject #2531) -- previously a bookmarkable `/_inbox/*` route with
 * its own bespoke `WDialog`. That dialog is gone along with the routes: this is now full-screen
 * overlay content exactly like `FileManager`/`PageHistoryOverlay`, switching between its two tabs
 * (Watching/Review) via local reactive state instead of child routes. The two tabs' actual content
 * is unchanged -- `InboxWatching`/`InboxReview` are the same components the old routed pages rendered.
 */

// PROPS

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('Inbox', opts)`), forwarded
 * here by `MainOverlayDialog.vue` (OpenProject #2530). `tab` picks which of the two sections opens;
 * `submissionId`/`from` are `InboxReview`'s own initial state, passed straight through.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

// -> A computed, not a plain array evaluated once at setup: a plain array's `t()` calls would freeze
//    these labels in whatever language was active when this overlay mounted, so switching interface
//    language would leave them stale until the overlay was closed and reopened.
const sidenav = computed(() => [
  {
    key: 'watching',
    label: t('inbox.inbox'),
    icon: 'mdi:inbox-full'
  },
  {
    key: 'review',
    label: t('inbox.pendingReview'),
    icon: 'la:clipboard-check'
  }
])

/** Which tab is showing. Local, plain reactive state -- no router involved (OpenProject #2531). */
const tab = ref(props.overlayOpts.tab === 'review' ? 'review' : 'watching')

// METHODS

function close() {
  siteStore.$patch({ overlay: '' })
}
</script>

<style lang="scss">
/*
  A foreground to go with the background -- the same fix `ProfileOverlay.vue`'s `.layout-profile-card`
  needed for the same reason (see its own comment): `w-layout` is a plain div, not a `WCard` (the one
  component that declares both halves of a surface itself), so without an explicit `color` here every
  label under `InboxWatching.vue`/`InboxReview.vue` (notifications, watched pages, the per-page watch
  preferences) inherited the document's default black text -- readable in light mode purely by
  accident, illegible against this overlay's own dark background in dark mode. The light value is the
  black it was already inheriting, so only dark mode actually changes.
*/
.inbox-overlay {
  @at-root .body--light & {
    background-color: #fff;
    color: var(--color-black);
  }
  @at-root .body--dark & {
    background-color: $dark-3;
    color: var(--color-white);
  }
}

.inbox-overlay-sidebar {
  @at-root .body--light & {
    background-color: $grey-1;
    border-inline-end: 1px solid rgba($dark-3, 0.1);
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-inline-end: 1px solid rgba(#fff, 0.12);
  }

  .w-list .w-item {
    font-weight: 500;
    color: $grey-9;

    @at-root .body--dark & {
      color: rgba(255, 255, 255, 0.75);
    }

    &.is-active {
      background: linear-gradient(to bottom, rgba($primary, 0.25), rgba($primary, 0.1));
      color: $primary;

      // -> WIcon draws an Iconify reference as <iconify-icon> and anything else via q-icon
      .w-icon,
      iconify-icon {
        color: $primary;
      }

      @at-root .body--dark & {
        color: var(--color-primary-light);

        .w-icon,
        iconify-icon {
          color: var(--color-primary-light);
        }
      }
    }
  }
}
</style>
