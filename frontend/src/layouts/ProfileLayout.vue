<template>
  <w-layout>
    <w-header>
      <header-nav />
    </w-header>
    <!--
      OpenProject #2510: the same FileManager-dialog treatment #2502 gave Inbox. `/_profile/*` stays a
      set of real, bookmarkable routes rather than moving onto the shared `MainOverlayDialog`/
      `siteStore.overlay` mechanism, but the card now lives inside a real, non-persistent `<w-dialog>`
      that is open for as long as this layout is mounted -- reproducing `MainOverlayDialog`'s blurred
      backdrop rather than sitting in a plain scrolling page. `.layout-profile` moves here from the old
      `w-page-container` for exactly that reason: it is what the stylesheet below styles the dialog's
      own backdrop/panel through.
    -->
    <w-dialog
      :model-value="dialogOpen"
      class="layout-profile"
      :aria-label="t('profile.title')"
      @update:model-value="onDialogUpdate">
      <div class="layout-profile-card">
        <!--
          FileManager's own header language (OpenProject #2415/#2502): a dark `.card-header` band, an
          icon plus title on the left, and a single white/grey-7 push button on the right. Profile had
          no Close or Back affordance of any kind before this -- see the WP description.
        -->
        <w-header class="layout-profile-hdr card-header px-4 py-2">
          <w-icon name="la:user-circle" left size="md" />
          <span>{{ t('profile.title') }}</span>
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
        <div class="layout-profile-body">
          <!--
            Below 900px the section list is a disclosure rather than a column beside the content: even
            shrunk to its own labels it is ~240px, and on a phone the fixed 300px of it left the content
            overflowing the card and clipped at the edge of the screen. Closed to start with, and it
            names the section being read -- so the bar that opens the nav is also what says where in
            the profile the reader is.
          -->
          <w-btn
            v-if="isNavCollapsed"
            class="layout-profile-navbtn"
            flat
            no-caps
            :icon="currentSection.icon"
            :label="currentSection.label"
            :aria-expanded="state.navOpen"
            @click="toggleNav">
            <w-icon
              class="layout-profile-navchevron"
              :class="{ 'is-open': state.navOpen }"
              name="mdi:chevron-down" />
          </w-btn>
          <div class="layout-profile-sd" v-show="!isNavCollapsed || state.navOpen">
            <w-list>
              <template v-for="navItem of sidenav" :key="navItem.key">
                <w-item
                  v-if="!navItem.disabled || flagsStore.experimental"
                  clickable
                  :to="`/_profile/` + navItem.key"
                  active-class="is-active"
                  :disabled="navItem.disabled">
                  <w-item-section side>
                    <w-icon :name="navItem.icon" />
                  </w-item-section>
                  <w-item-section>
                    <w-item-label>{{ navItem.label }}</w-item-label>
                  </w-item-section>
                </w-item>
              </template>
              <template v-if="flagsStore.experimental">
                <w-separator inset spaced="sm" />
                <w-item clickable :to="`/_user/` + userStore.id">
                  <w-item-section side>
                    <w-icon name="la:id-card" />
                  </w-item-section>
                  <w-item-section>
                    <w-item-label>{{ t('profile.viewPublicProfile') }}</w-item-label>
                  </w-item-section>
                </w-item>
              </template>
              <w-separator inset spaced="sm" />
              <w-item clickable @click="userStore.logout()">
                <w-item-section side>
                  <w-icon name="la:sign-out-alt" color="negative" />
                </w-item-section>
                <w-item-section>
                  <w-item-label class="text-negative">{{ t('common.header.logout') }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </div>
          <router-view />
        </div>
      </div>
    </w-dialog>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useMeta } from '@/composables/meta'
import { useMinWidth } from '@/composables/screen'

import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import HeaderNav from '@/components/HeaderNav.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'

// STORES

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// META

// -> The site's own name rather than the literal `Wiki.js`, as the page view does. A getter, so the
//    template is recomputed when the site config arrives -- see the note in `MainLayout`.
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => `${title} - ${t('profile.title')} - ${siteTitle}`
  }
})

// DIALOG

/**
 * Open for as long as this layout is mounted -- there is nothing else on `/_profile/*` for the
 * dialog to be an alternative TO, it is simply this route's own chrome (OpenProject #2510, following
 * #2502's decided mechanism for Inbox). One-way bound on purpose: `onDialogUpdate` below reacts to a
 * dismissal by navigating away rather than by flipping this back to `false` itself, since leaving
 * `/_profile` unmounts the layout (and the dialog with it) anyway.
 */
const dialogOpen = ref(true)

// -> Where "Close" returns to. Captured once, in onMounted rather than read fresh at click time --
//    this layout's own route component is shared by every `/_profile/*` child (see router/routes.js),
//    so Vue Router reuses the same instance across those child routes and onMounted only fires again
//    on a real re-entry from outside `/_profile`. Reading history state at click time instead would
//    drift to whatever profile section the reader last switched to. Same fallback idiom as
//    `InboxLayout`'s own `returnPath` (itself following Index.vue/Search.vue's goBack()): no captured
//    history (a direct/bookmarked/emailed link) goes home instead.
const returnPath = ref('/')

onMounted(() => {
  const back = window.history.state?.back
  returnPath.value = typeof back === 'string' ? back : '/'
})

function close() {
  router.push(returnPath.value)
}

/**
 * The dialog is deliberately not `persistent`: Escape and a backdrop click both close it the same way
 * the Close button does, since there is no unsaved state here to protect.
 */
function onDialogUpdate(value) {
  if (!value) {
    close()
  }
}

// DATA

// -> A computed, not a plain array evaluated once at setup: `t()` inside a plain array is only ever
//    run in the language active when this layout mounts, so switching interface language would leave
//    these labels stuck in the old one until a remount. AdminLayout's sidenav evaluates `t()` in the
//    template for the same reason; this one has to build a list rather than iterate keys directly, so
//    a computed is what gets the same freshness.
const sidenav = computed(() => [
  {
    key: 'info',
    label: t('profile.title'),
    icon: 'la:user-circle'
  },
  {
    key: 'avatar',
    label: t('profile.avatar'),
    icon: 'la:otter'
  },
  {
    key: 'auth',
    label: t('profile.auth'),
    icon: 'la:key'
  },
  {
    key: 'groups',
    label: t('profile.groups'),
    icon: 'la:users'
  },
  {
    key: 'api',
    label: t('profile.api.title'),
    icon: 'la:key'
  },
  {
    key: 'notifications',
    label: t('profile.notifications'),
    icon: 'la:bell'
  },
  // {
  //   key: 'pages',
  //   label: 'My Pages',
  //   icon: 'la:file-alt',
  //   disabled: true
  // },
  {
    key: 'activity',
    label: t('profile.activity'),
    icon: 'la:history',
    disabled: true
  }
])

const state = reactive({
  /** Whether the section list is open. Only consulted below 900px, where it is a disclosure. */
  navOpen: false
})

// COMPUTED

/**
 * Below 900px, where the nav stops being a column beside the content and becomes a disclosure above it.
 *
 * This layout's own breakpoint rather than one of the app's: it is the width at which a nav column shrunk
 * to its own labels (~240px, see the stylesheet) is still more than the content can spare. The stylesheet
 * has to agree with it — `$nav-collapse-max` is the same boundary from the other side.
 *
 * -> Keyed off the BROWSER viewport, not this dialog panel's own rendered width (OpenProject #2510).
 *    The panel is sized to keep the two agreeing at ordinary window widths -- see the dialog sizing
 *    comment in the stylesheet below for the roughly 900-960px-wide window range where they can drift
 *    apart. Making this container-aware instead would need a ResizeObserver on the panel itself rather
 *    than `useMinWidth`'s shared `matchMedia`, which is a rewrite of this layout's own responsive
 *    design, not chrome parity with Inbox -- out of scope for this pass.
 */
const isAtLeast900 = useMinWidth(900)
const isNavCollapsed = computed(() => !isAtLeast900.value)

/**
 * The section being read, which is what the collapsed nav bar is labelled with.
 *
 * Falls back to the profile's own name for a path the list does not cover — the public profile, or a
 * `/_profile` with no section — so the bar always says something.
 */
const currentSection = computed(() => {
  return (
    sidenav.value.find((item) => route.path === `/_profile/${item.key}`) ?? {
      label: t('profile.title'),
      icon: 'la:user-circle'
    }
  )
})

// WATCHERS

watch(
  () => route.path,
  async (newValue) => {
    // -> Picking a section is what the open list is for, so arriving at one puts it away again
    state.navOpen = false
    if (!newValue.startsWith('/_profile')) {
      return
    }
    if (!userStore.authenticated) {
      router.replace('/login')
    }
  },
  { immediate: true }
)

// METHODS

function toggleNav() {
  state.navOpen = !state.navOpen
}
</script>

<style lang="scss">
/*
  Where this card's two desktop assumptions give out. Both are its own, not the app's -- see the comment
  on the media queries at the bottom of this block. Stated as `max` values, just under the width the next
  layout up starts at, the way `_palette.scss` states the shared ones.

  `$nav-collapse-max` has to agree with the 900px `useMinWidth` above it, which is what decides whether
  the disclosure button is rendered at all.
*/
$nav-collapse-max: 899.98px;
$nav-shrink-max: 1199.98px;

/*
  Ported from the Quasar dialog internals onto WDialog's own structure, same as `.main-overlay` in
  MainLayout.vue -- reproduced here as a local rule rather than shared, since `.main-overlay` also
  carries full-screen-overlay-specific viewport padding and a `.w-dialog-panel` gradient tuned for
  FileManager, neither of which this modal wants (OpenProject #2510, mirroring #2502's InboxLayout).
*/
.layout-profile {
  > .w-dialog-backdrop {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px) saturate(180%);
  }

  /*
    Comfortably smaller than FileManager's `full-width full-height` -- account settings forms and a
    handful of list rows need far less room than a folder tree plus table. Wider/taller than Inbox's
    900x620 (OpenProject #2502): this card's two-column settings rows, plus its own left rail, want
    more room than Inbox's two short lists. Capped by viewport fraction rather than a bare pixel pair
    so a small window still gets full margins instead of overflowing.
  */
  > .w-dialog-viewport > .w-dialog-panel {
    width: 1100px;
    max-width: 92vw;
    height: 760px;
    max-height: 82vh;
  }

  &-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    // -> Clips the header and body below to the panel's own rounded corners regardless of their own
    //    radius (or lack of one), the same trick InboxLayout's card relies on for the same reason.
    overflow: hidden;

    /*
      A foreground to go with the background.

      This card is a plain div rather than a WCard, and a WCard is what declares BOTH halves of a
      surface. Setting only the background meant everything inside inherited the document's black --
      row titles, input values, select values alike -- which is invisible against the dark surface.
      The light value is the black it was already inheriting, so only dark mode changes.
    */
    @at-root .body--light & {
      background-color: #fff;
      color: var(--color-black);
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      color: var(--color-white);
    }
  }

  &-hdr {
    flex: 0 0 auto;
  }

  &-body {
    flex: 1 1 auto;
    display: flex;
    align-items: stretch;
    // -> The panel above is a fixed box now rather than a page that grows with its content, so
    //    whatever doesn't fit has to scroll internally -- see `.w-page` below, which is where that
    //    scroll actually happens (the rail scrolls too, but rarely needs to: six items fit easily).
    overflow: hidden;
  }

  &-sd {
    flex: 0 0 300px;
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

        // -> Same lightened brand blue as the section headings; `$primary` is too dim on this surface
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

  .w-page {
    flex: 1 1;
    overflow-y: auto;

    @at-root .body--light & {
      border-left: 1px solid #fff;
    }
    @at-root .body--dark & {
      border-left: 1px solid rgba($dark-6, 0.75);
    }
  }

  .actions-bar {
    display: flex;
    padding: 16px;
    background:
      linear-gradient(to right, #fff, transparent),
      linear-gradient(to bottom, rgba($secondary, 0.1), transparent);
    justify-content: flex-end;
    position: relative;

    @at-root .body--dark & {
      background:
        linear-gradient(to right, $dark-3, transparent),
        linear-gradient(to bottom, rgba($secondary, 0.1), transparent);
    }

    &:before {
      content: '';
      width: 100%;
      height: 10px;
      background:
        linear-gradient(to right, #fff, transparent),
        linear-gradient(to top, rgba($secondary, 0.05), transparent);
      position: absolute;
      top: -13px;
      left: 0;
      z-index: 0;

      @at-root .body--dark & {
        background:
          linear-gradient(to right, $dark-3, transparent),
          linear-gradient(to top, rgba($secondary, 0.05), transparent);
      }
    }

    &:after {
      content: '';
      width: 100%;
      height: 1px;
      background: linear-gradient(to right, transparent, rgba($secondary, 0.25));
      position: absolute;
      top: -2px;
      left: 0;
      z-index: 0;
    }
  }

  /*
    TWO NARROWER LAYOUTS
    =====================

    This card is a fixed box (see the panel sizing above) with a 300px nav column down its left side --
    pitched for a desktop window, and it gives that up at two different widths, one at a time rather
    than all at once:

      below 1200px   the nav column stops being 300px wide and shrinks to its own labels, which hands
                     the content back the width it is running out of
      below 900px    the nav column goes altogether and becomes a disclosure above the content, because
                     even shrunk to its labels it is ~240px that the content needs more; the settings
                     rows are still two columns here, which is the point of taking the nav out rather
                     than stacking them

    Ordered narrowest-last, so each block overrides the one above it where the two speak about the same
    property. `$nav-*-max` are this layout's own -- deliberately not in `_palette.scss`, which is for
    breakpoints the whole app shares: these two describe when THIS card runs out of room, which is a
    function of its own nav column and of nothing else. A third, sub-600px tier used to make the card
    become the screen itself (full-bleed, square corners) when this was a plain scrolling page; the
    dialog now controls sizing uniformly across every width instead (OpenProject #2510), so that tier
    is gone and the settings-row-stacking rule it used to share space with lives in its own query below.
  */

  /* --- Below 1200px: the nav gives up its fixed width -------------------------------------------- */
  @media (max-width: $nav-shrink-max) {
    /* -> `auto` basis: the column is as wide as its longest label needs, instead of 300px regardless */
    &-sd {
      flex: 0 0 auto;
    }
  }

  /* --- Below 900px: the nav is a disclosure above the content ------------------------------------- */
  @media (max-width: $nav-collapse-max) {
    &-body {
      flex-direction: column;
    }

    /* -> The disclosure's bar. Full width, with the chevron pushed to the far end from the label. */
    &-navbtn {
      justify-content: space-between;

      @at-root .body--light & {
        background-color: $grey-1;
        border-bottom: 1px solid $grey-3;
      }
      @at-root .body--dark & {
        background-color: $dark-4;
        border-bottom: 1px solid $dark-2;
      }
    }

    /* -> The button's whole content is one flex row, so the chevron needs pushing to the end of it */
    &-navbtn > span {
      flex: 1;
      justify-content: space-between;
    }

    &-navchevron {
      transition: transform 0.2s var(--ease-standard);

      &.is-open {
        transform: rotate(180deg);
      }
    }

    /*
      The nav, no longer a column at all: the width of the card, with the seam that divided the two
      columns moving from its right edge to its bottom one. Per theme, because that is where the rules
      being replaced are declared -- at three classes each, which a plain override here would lose to.
    */
    &-sd {
      flex: none;
      width: 100%;

      @at-root .body--light & {
        border-right: 0;
        border-bottom: 1px solid $grey-3;
        box-shadow: none;
      }
      @at-root .body--dark & {
        border-right: 0;
        border-bottom: 1px solid rgba(#fff, 0.12);
        box-shadow: none;
      }
    }

    /* -> The seam is the nav's bottom border now, and a left one would draw down the content's own edge */
    .w-page {
      @at-root .body--light & {
        border-left: 0;
      }
      @at-root .body--dark & {
        border-left: 0;
      }
    }
  }

  /* --- Below 600px: a settings row stacks ---------------------------------------------------------- */
  @media (max-width: $breakpoint-xs-max) {
    /*
      A settings row stacks: its label and its field are two MAIN sections, which share the row's width
      equally -- 175px each on this screen, too narrow for either. The field takes a line of its own under
      the label it belongs to, full width, and the 8px gutter between two columns becomes the gap between
      two lines.

      Scoped to `.w-page`, the content column: the nav's own rows are a side section and a main one, which
      have no reason to wrap and would only be loosened by this.
    */
    .w-page .w-item {
      flex-wrap: wrap;
    }

    /*
      `flex-basis`, not `width`: the section carries Tailwind's `flex-1`, which is `flex: 1 1 0%` -- and a
      flex item is sized by its basis, so a width of 100% was simply ignored and the two sections went on
      sharing the line. 100% is wider than the row can fit beside anything, which is what pushes it onto a
      line of its own.
    */
    .w-page .w-item-section--main + .w-item-section--main {
      flex: 1 0 100%;
      margin-top: 0.5rem;
      margin-left: 0;
    }
  }
}

body.body--dark {
  background-color: $dark-6;
}
</style>
