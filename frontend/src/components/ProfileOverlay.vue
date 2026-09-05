<template>
  <div class="layout-profile-card">
    <!--
      FileManager's own header language (OpenProject #2415/#2502, carried through #2510): a dark
      `.card-header` band, an icon plus title on the left, and a single white/grey-7 push button on
      the right.
    -->
    <w-header class="layout-profile-hdr card-header px-4 py-2">
      <w-icon name="tabler:user-circle" left size="md" />
      <span>{{ t('profile.title') }}</span>
      <w-space />
      <w-btn-group>
        <w-btn
          color="white"
          text-color="text-secondary"
          :label="t('common.actions.close')"
          :aria-label="t('common.actions.close')"
          icon="tabler:x"
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
        :icon="currentSection.icon"
        :label="currentSection.label"
        :aria-expanded="state.navOpen"
        @click="toggleNav">
        <w-icon
          class="layout-profile-navchevron"
          :class="{ 'is-open': state.navOpen }"
          name="tabler:chevron-down" />
      </w-btn>
      <div class="layout-profile-sd" v-show="!isNavCollapsed || state.navOpen">
        <w-list>
          <template v-for="navItem of sidenav" :key="navItem.key">
            <w-item
              v-if="!navItem.disabled || flagsStore.experimental"
              clickable
              :class="{ 'is-active': navItem.key === state.section }"
              :disabled="navItem.disabled"
              @click="selectSection(navItem.key)">
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
            <!-- -> A real navigation away from the overlay, so it closes rather than floating over
                    whatever page this lands the reader on -- same idiom as FileManager's own
                    @new-page close-on-navigate. -->
            <w-item clickable :to="`/_user/` + userStore.id" @click="close">
              <w-item-section side>
                <w-icon name="tabler:id" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ t('profile.viewPublicProfile') }}</w-item-label>
              </w-item-section>
            </w-item>
          </template>
          <w-separator inset spaced="sm" />
          <w-item clickable @click="onLogoutClick">
            <w-item-section side>
              <w-icon name="tabler:logout" color="negative" />
            </w-item-section>
            <w-item-section>
              <w-item-label class="text-negative">{{ t('common.header.logout') }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-list>
      </div>
      <component :is="sectionComponents[state.section]" />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, defineAsyncComponent, onBeforeUnmount, reactive } from 'vue'

import { useMinWidth } from '@/composables/screen'

import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * OpenProject #2532: a true `MainOverlayDialog` entry rather than a set of real, bookmarkable
 * `/_profile/*` routes -- following the same `defineAsyncComponent` pattern `FileManager.vue` uses
 * for its own dialog content. `MainOverlayDialog.vue` supplies the dialog wrapper, scrim and sizing
 * now (the `.main-overlay` panel every other overlay entry shares), so this component owns only the
 * card surface, the section rail and whichever section's content is currently selected -- all local
 * `ref`/`reactive` state, no router involved.
 */

// PROPS

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('Profile', { section:
 * 'api' })`, e.g. `AdminApi.vue`'s personal-token note), forwarded here by `MainOverlayDialog.vue`
 * (OpenProject #2530). `state.section` below reads this once, at setup, not `siteStore.overlayOpts`
 * directly.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

// STORES

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// SECTIONS

/**
 * Lazy-loaded exactly like `MainOverlayDialog.vue`'s own `overlays` map -- these six were previously
 * routed `/_profile/*` children (`router/routes.js`) and are unchanged themselves, only reached
 * differently now.
 */
const sectionComponents = {
  info: defineAsyncComponent(() => import('@/pages/ProfileInfo.vue')),
  avatar: defineAsyncComponent(() => import('@/pages/ProfileAvatar.vue')),
  auth: defineAsyncComponent(() => import('@/pages/ProfileAuth.vue')),
  groups: defineAsyncComponent(() => import('@/pages/ProfileGroups.vue')),
  api: defineAsyncComponent(() => import('@/pages/ProfileApi.vue')),
  notifications: defineAsyncComponent(() => import('@/pages/ProfileNotifications.vue'))
}

// DATA

// -> A computed, not a plain array evaluated once at setup: `t()` inside a plain array is only ever
//    run in the language active when this component mounts, so switching interface language would
//    leave these labels stuck in the old one until a remount. AdminLayout's sidenav evaluates `t()`
//    in the template for the same reason; this one has to build a list rather than iterate keys
//    directly, so a computed is what gets the same freshness.
const sidenav = computed(() => [
  {
    key: 'info',
    // -> `profile.identity`, not `profile.title`: the overlay itself is "Profile", so a first rail
    //    entry by the same name read as a link back to the thing you are already in. It is the
    //    reader's own identity -- name, address, location, job title -- which is what it now says.
    label: t('profile.identity'),
    icon: 'tabler:user-circle'
  },
  {
    key: 'avatar',
    label: t('profile.avatar'),
    icon: 'tabler:paw'
  },
  {
    key: 'auth',
    label: t('profile.auth'),
    icon: 'tabler:key'
  },
  {
    key: 'groups',
    label: t('profile.groups'),
    icon: 'tabler:users'
  },
  {
    key: 'api',
    label: t('profile.api.title'),
    icon: 'tabler:key'
  },
  {
    key: 'notifications',
    label: t('profile.notifications'),
    icon: 'tabler:bell'
  },
  // {
  //   key: 'pages',
  //   label: 'My Pages',
  //   icon: 'tabler:file-text',
  //   disabled: true
  // },
  {
    key: 'activity',
    label: t('profile.activity'),
    icon: 'tabler:history',
    disabled: true
  }
])

const state = reactive({
  /** Whether the section list is open. Only consulted below 900px, where it is a disclosure. */
  navOpen: false,
  /**
   * The section on screen -- a plain local field, no route involved. Defaults to `info` unless the
   * opener asked for a specific one (`overlayOpts.section`); an unknown or `activity`'s
   * (permanently disabled) key falls back the same way rather than rendering nothing.
   */
  section: Object.hasOwn(sectionComponents, props.overlayOpts.section)
    ? props.overlayOpts.section
    : 'info'
})

// COMPUTED

/**
 * Below 900px, where the nav stops being a column beside the content and becomes a disclosure above it.
 *
 * This component's own breakpoint rather than one of the app's: it is the width at which a nav column
 * shrunk to its own labels (~240px, see the stylesheet) is still more than the content can spare. The
 * stylesheet has to agree with it — `$nav-collapse-max` is the same boundary from the other side. Search's
 * own filter-panel disclosure (`pages/Search.vue`) uses this same number for the same reason: the two
 * cards are the same shape.
 *
 * -> Keyed off the BROWSER viewport, not this dialog panel's own rendered width (OpenProject #2510).
 *    The panel is sized to keep the two agreeing at ordinary window widths -- see the dialog sizing
 *    comment in the stylesheet below for the roughly 900-960px-wide window range where they can drift
 *    apart.
 */
const isAtLeast900 = useMinWidth(900)
const isNavCollapsed = computed(() => !isAtLeast900.value)

/**
 * The section being read, which is what the collapsed nav bar is labelled with.
 */
const currentSection = computed(() => {
  return sidenav.value.find((item) => item.key === state.section) ?? sidenav.value[0]
})

// METHODS

function toggleNav() {
  state.navOpen = !state.navOpen
}

function selectSection(key) {
  state.section = key
  // -> Picking a section is what the open list is for, so choosing one puts it away again
  state.navOpen = false
}

function close() {
  siteStore.overlay = ''
}

function onLogoutClick() {
  // -> Logging out turns this reader into a guest, who has no profile to look at -- close first so
  //    the overlay doesn't linger open over whatever page the redirect below lands on.
  close()
  userStore.logout()
}

onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
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

.layout-profile-card {
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
    background-color: $surface;
    color: $text-body;
  }
  @at-root .body--dark & {
    background-color: $dark-3;
    color: $text-dark;
  }
}

.layout-profile-hdr {
  flex: 0 0 auto;
}

.layout-profile-body {
  flex: 1 1 auto;
  display: flex;
  align-items: stretch;
  // -> The card above fills whatever the outer `MainOverlayDialog` panel gives it rather than growing
  //    with its content, so whatever doesn't fit has to scroll internally -- see `.w-page` below,
  //    which is where that scroll actually happens (the rail scrolls too, but rarely needs to: six
  //    items fit easily).
  overflow: hidden;
}

.layout-profile-sd {
  flex: 0 0 300px;
  overflow-y: auto;

  /*
    The section rail: Cardinal's tint, ruled off with a hairline. The inset white/near-black
    box-shadow that used to sit alongside the border was a bevel, drawing a second, lighter line just
    inside the first -- which is exactly the relief this language does without.
  */
  @at-root .body--light & {
    background-color: $tint-alt;
    border-inline-end: 1px solid $hairline;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-inline-end: 1px solid $hairline-dark;
  }

  .w-list .w-item {
    font-weight: 400;
    color: $slate;
    border-inline-start: 2px solid transparent;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }

    // -> The same "you are here" mark as the inbox rail, the site sidebar and the folder tree
    &.is-active {
      background-color: $surface;
      border-inline-start-color: $accent-fill;
      color: $ink;
      font-weight: 500;

      // -> WIcon draws an Iconify reference as <iconify-icon> and anything else via q-icon
      .w-icon,
      iconify-icon {
        color: $accent-fill;
      }

      @at-root .body--dark & {
        background-color: $dark-3;
        color: $text-dark;

        .w-icon,
        iconify-icon {
          color: $accent-dark;
        }
      }
    }
  }
}

.layout-profile-body .w-page {
  flex: 1 1;
  overflow-y: auto;

  // -> The rail already draws the seam between the two columns; a second line here doubled it
}

/*
  The save bar at the foot of a section. A hairline above it and the page tint behind it, which is
  how every other action bar in the language is drawn (`WCardActions`, the dialogs' own footers).

  What this replaces was four stacked gradients across three elements -- a white-to-transparent wash
  crossed with a green one, a 10px band above it, and a fading rule -- to suggest the bar lifting off
  the content. One rule says the same thing.
*/
.layout-profile-body .actions-bar {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  background-color: $paper;
  border-top: 1px solid $hairline;

  @at-root .body--dark & {
    background-color: $dark-4;
    border-top-color: $hairline-dark;
  }
}

/*
  TWO NARROWER LAYOUTS
  =====================

  This card fills whatever the outer `MainOverlayDialog` panel gives it (see the panel sizing on
  `.main-overlay` in `MainLayout.vue`) with a 300px nav column down its left side, and gives that up
  at two different widths, one at a time rather than all at once:

    below 1200px   the nav column stops being 300px wide and shrinks to its own labels, which hands
                   the content back the width it is running out of
    below 900px    the nav column goes altogether and becomes a disclosure above the content, because
                   even shrunk to its labels it is ~240px that the content needs more; the settings
                   rows are still two columns here, which is the point of taking the nav out rather
                   than stacking them

  Ordered narrowest-last, so each block overrides the one above it where the two speak about the same
  property. `$nav-*-max` are this component's own -- deliberately not in `_palette.scss`, which is for
  breakpoints the whole app shares: these two describe when THIS card runs out of room, which is a
  function of its own nav column and of nothing else.
*/

/* --- Below 1200px: the nav gives up its fixed width -------------------------------------------- */
@media (max-width: $nav-shrink-max) {
  /* -> `auto` basis: the column is as wide as its longest label needs, instead of 300px regardless */
  .layout-profile-sd {
    flex: 0 0 auto;
  }
}

/* --- Below 900px: the nav is a disclosure above the content ------------------------------------- */
@media (max-width: $nav-collapse-max) {
  .layout-profile-body {
    flex-direction: column;
  }

  /* -> The disclosure's bar. Full width, with the chevron pushed to the far end from the label. */
  .layout-profile-navbtn {
    justify-content: space-between;

    @at-root .body--light & {
      background-color: $tint-alt;
      border-bottom: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
      border-bottom: 1px solid $hairline-dark;
    }
  }

  /* -> The button's whole content is one flex row, so the chevron needs pushing to the end of it */
  .layout-profile-navbtn > span {
    flex: 1;
    justify-content: space-between;
  }

  .layout-profile-navchevron {
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
  .layout-profile-sd {
    flex: none;
    width: 100%;

    @at-root .body--light & {
      border-inline-end: 0;
      border-bottom: 1px solid $hairline;
    }
    @at-root .body--dark & {
      border-inline-end: 0;
      border-bottom: 1px solid $hairline-dark;
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
  .layout-profile-body .w-page .w-item {
    flex-wrap: wrap;
  }

  /*
    `flex-basis`, not `width`: the section carries Tailwind's `flex-1`, which is `flex: 1 1 0%` -- and a
    flex item is sized by its basis, so a width of 100% was simply ignored and the two sections went on
    sharing the line. 100% is wider than the row can fit beside anything, which is what pushes it onto a
    line of its own.
  */
  .layout-profile-body .w-page .w-item-section--main + .w-item-section--main {
    flex: 1 0 100%;
    margin-top: 0.5rem;
    margin-inline-start: 0;
  }
}
</style>
