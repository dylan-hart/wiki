<template>
  <w-layout>
    <w-header>
      <header-nav />
    </w-header>
    <w-page-container />
    <!--
      OpenProject #2502: the FileManager-styled card this used to hand-roll (a manually drawn dark
      backdrop plus a plain div playing dialog, moved-in from #2415) looked the part but wasn't a real
      dialog -- no blurred backdrop, and "Go Back" read as page navigation rather than a dismiss action.
      This now renders through the same `WDialog` every other overlay in the app uses, just not routed
      through `MainOverlayDialog`/`siteStore.overlay`: `/_inbox/watching` and `/_inbox/review` stay
      bookmarkable routes (the reason #2415 gave for not converting to the shared mechanism), and this
      layout opens its own dialog for as long as one of them is the active route -- "closing" it means
      navigating away, not the shared mechanism's `siteStore.overlay = null`.

      Deliberately not `persistent`: there is nothing here a reader can lose by dismissing it (two
      read-only lists), so Escape and a backdrop click both close it exactly like the header's own Close
      button -- what an actual modal dialog is expected to do, unlike the always-`persistent` overlays
      `MainOverlayDialog` hosts (those can hold unsaved form state, this never does).

      Sized well under `MainOverlayDialog`'s `full-width full-height` (FileManager's own size): this is
      two short lists, not a page-filling workspace, so `.layout-inbox-card` below fixes a comfortably
      smaller width/height instead and scrolls its rail and content internally.
    -->
    <w-dialog
      model-value
      class="layout-inbox"
      :aria-label="t('inbox.title')"
      @update:model-value="close">
      <w-card class="layout-inbox-card">
        <w-header class="layout-inbox-hdr card-header px-4 py-2">
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
        <div class="layout-inbox-body">
          <div class="layout-inbox-sd">
            <w-list>
              <w-item
                v-for="navItem of sidenav"
                :key="navItem.key"
                clickable
                :to="`/_inbox/` + navItem.key"
                active-class="is-active">
                <w-item-section side>
                  <w-icon :name="navItem.icon" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ navItem.label }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </div>
          <router-view />
        </div>
      </w-card>
    </w-dialog>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useMeta } from '@/composables/meta'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import HeaderNav from '@/components/HeaderNav.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'

/**
 * The inbox: what has come in for this user, what they are following, and what is waiting on them.
 *
 * The site's own header stays mounted behind it (this layout is still reached by a bookmarkable
 * `/_inbox/*` route, not opened from wherever the reader happens to be), and the inbox itself opens as
 * a real `WDialog` over that -- blurred backdrop, a Close button, a size well under a full-screen
 * overlay's -- rather than a page-filling card standing in for one. See the template comment above for
 * why this isn't the shared `MainOverlayDialog`/`siteStore.overlay` mechanism instead.
 */

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// -> Where "Close" returns to. Captured once, in onMounted rather than read fresh at click time --
//    this layout's own route component is shared by both `/_inbox/watching` and `/_inbox/review`
//    (see router/routes.js), so Vue Router reuses the same instance across those two child routes and
//    onMounted only fires again on a real re-entry from outside `/_inbox`. Reading history state at
//    click time instead would drift to `/_inbox/watching` once the reader had switched inbox tabs --
//    the Inbox has no natural "up" location the way Admin's sidebar does, so this is the one chance to
//    remember where the reader actually came from. Same fallback idiom as Index.vue/Search.vue's own
//    goBack(): no captured history (a direct/bookmarked/emailed link) goes home instead.
const returnPath = ref('/')

onMounted(() => {
  const back = window.history.state?.back
  returnPath.value = typeof back === 'string' ? back : '/'
})

// -> The dialog's only exit: the header's Close button calls this directly, and it also answers
//    `WDialog`'s own `update:model-value` event (fired on Escape or a backdrop click, since this
//    dialog is not `persistent`) -- both dismiss the same way, by navigating back to wherever the
//    reader came from.
function close() {
  router.push(returnPath.value)
}

// I18N

const { t } = useI18n()

// META

// -> The site's own name rather than the literal `Wiki.js`, as the page view does. A getter, so the
//    template is recomputed when the site config arrives -- see the note in `MainLayout`.
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => `${title} - ${t('inbox.title')} - ${siteTitle}`
  }
})

// DATA

// -> A computed, not a plain array evaluated once at setup -- see ProfileLayout's identical comment;
//    a plain array's t() calls freeze these labels in whatever language was active when this layout
//    mounted, so switching interface language would leave them stale until a remount.
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

// WATCHERS

// -> There is nothing in here for somebody with no account, and every section is about them
watch(
  () => route.path,
  (newValue) => {
    if (newValue.startsWith('/_inbox') && !userStore.authenticated) {
      router.replace('/login')
    }
  },
  { immediate: true }
)
</script>

<style lang="scss">
/*
  The blurred backdrop is `MainOverlayDialog`'s own (`.main-overlay > .w-dialog-backdrop` in
  `MainLayout.vue`), reproduced here rather than shared verbatim: reusing that class outright would
  also pull in its viewport padding and `.w-dialog-panel` gradient background, both tuned for a
  full-width/full-height overlay like FileManager, not this dialog's fixed, comfortably smaller size.
*/
.layout-inbox {
  > .w-dialog-backdrop {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px) saturate(180%);
  }
}

.layout-inbox-card {
  // -> Well under `MainOverlayDialog`'s `full-width full-height` (what FileManager renders at):
  //    two short lists don't need a page-filling workspace. `max-width`/`max-height` are what keep
  //    this from overflowing a small viewport the way a bare fixed size would.
  width: 900px;
  max-width: 92vw;
  height: 620px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  // -> Clips the header and rail below to the dialog panel's own rounded corners (`WDialog` already
  //    rounds and clips the panel itself, but the header's own background band still needs the same
  //    treatment at this level so it doesn't square off past that curve).
  overflow: hidden;

  @at-root .body--light & {
    background-color: #fff;
    color: var(--color-black);
  }
  @at-root .body--dark & {
    background-color: $dark-3;
    color: var(--color-white);
  }
}

.layout-inbox-hdr {
  flex: 0 0 auto;
}

.layout-inbox-body {
  flex: 1 1 auto;
  // -> Lets the rail and the routed content below scroll independently inside the fixed-height card,
  //    instead of growing it past `max-height` -- see `.w-page` below.
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.layout-inbox-sd {
  flex: 0 0 260px;
  overflow-y: auto;

  @at-root .body--light & {
    background-color: $grey-1;
    border-right: 1px solid rgba($dark-3, 0.1);
    box-shadow: inset -1px 0 0 #fff;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-right: 1px solid rgba(#fff, 0.12);
    box-shadow: inset -1px 0 0 rgba($dark-6, 0.5);
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

.layout-inbox-card .w-page {
  flex: 1 1;
  min-height: 0;
  overflow-y: auto;

  @at-root .body--light & {
    border-left: 1px solid #fff;
  }
  @at-root .body--dark & {
    border-left: 1px solid rgba($dark-6, 0.75);
  }
}

body.body--dark {
  background-color: $dark-6;
}
</style>
