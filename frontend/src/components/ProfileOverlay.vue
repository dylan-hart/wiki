<template>
  <div class="layout-profile-card">
    <w-header class="layout-profile-hdr card-header">
      <w-icon name="tabler:user-circle" left size="md" />
      <span>{{ t('profile.title') }}</span>
      <w-space />
      <w-btn-group>
        <w-btn
          color="white"
          text-color="text-secondary"
          :label="isSavingVisible ? t('profile.closeDisabledLabel') : t('common.actions.close')"
          :aria-label="
            isSavingVisible ? t('profile.closeDisabledLabel') : t('common.actions.close')
          "
          icon="tabler:x"
          :loading="isSavingVisible"
          @click="close" />
      </w-btn-group>
    </w-header>
    <div class="layout-profile-body">
      <!--
        Below 900px the section list is a disclosure rather than a column beside the content: even
        shrunk to its own labels it takes width the content needs more.
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
                    whatever page it lands the reader on. -->
            <w-item
              clickable
              data-testid="profile-preview-public"
              :disabled="pendingProfileSaves > 0"
              @click="previewPublicProfile">
              <w-item-section side>
                <w-icon name="tabler:id" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ t('profile.previewPublicProfile') }}</w-item-label>
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
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, reactive } from 'vue'

import { useMinWidth } from '@/composables/screen'
import { openProfilePopover } from '@/composables/profilePopover'
import { isSavingVisible, pendingProfileSaves } from '@/composables/profileSaving'

import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * `MainOverlayDialog.vue` supplies the dialog wrapper, scrim and sizing (the `.main-overlay` panel
 * every overlay entry shares), so this component owns only the card surface, the section rail and
 * whichever section's content is selected -- all local `ref`/`reactive` state, no router involved.
 */

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('Profile', { section:
 * 'api' })`), forwarded here by `MainOverlayDialog.vue`. `state.section` below reads it once, at
 * setup, not `siteStore.overlayOpts` directly.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const sectionComponents = {
  info: defineAsyncComponent(() => import('@/pages/ProfileInfo.vue')),
  preferences: defineAsyncComponent(() => import('@/pages/ProfilePreferences.vue')),
  avatar: defineAsyncComponent(() => import('@/pages/ProfileAvatar.vue')),
  auth: defineAsyncComponent(() => import('@/pages/ProfileAuth.vue')),
  groups: defineAsyncComponent(() => import('@/pages/ProfileGroups.vue')),
  api: defineAsyncComponent(() => import('@/pages/ProfileApi.vue')),
  notifications: defineAsyncComponent(() => import('@/pages/ProfileNotifications.vue'))
}

// -> A computed, not a plain array evaluated once at setup: `t()` run eagerly would leave these
//    labels in whichever language was active at mount until a remount.
const sidenav = computed(() => [
  {
    key: 'info',
    // -> `profile.identity`, not `profile.title`: the overlay itself is "Profile", so a first rail
    //    entry by the same name reads as a link back to where the reader already is.
    label: t('profile.identity'),
    icon: 'tabler:id'
  },
  {
    key: 'preferences',
    label: t('profile.preferences'),
    icon: 'tabler:adjustments'
  },
  {
    key: 'avatar',
    label: t('profile.avatar'),
    icon: 'tabler:photo'
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
    icon: 'tabler:api'
  },
  {
    key: 'notifications',
    label: t('profile.notifications'),
    icon: 'tabler:bell'
  },
  {
    key: 'activity',
    label: t('profile.activity'),
    icon: 'tabler:history',
    disabled: true
  }
])

const state = reactive({
  /** Only consulted below 900px, where the section list is a disclosure. */
  navOpen: false,
  section: Object.hasOwn(sectionComponents, props.overlayOpts.section)
    ? props.overlayOpts.section
    : 'preferences'
})

/**
 * This component's own breakpoint rather than one of the app's: it is the width at which a nav
 * column shrunk to its own labels is still more than the content can spare. The stylesheet has to
 * agree with it — `899.98px` is the same boundary from the other side.
 *
 * -> Keyed off the BROWSER viewport, not this dialog panel's own rendered width, which can drift
 *    from it at window widths close to the breakpoint.
 */
const isAtLeast900 = useMinWidth(900)
const isNavCollapsed = computed(() => !isAtLeast900.value)

const currentSection = computed(() => {
  return sidenav.value.find((item) => item.key === state.section) ?? sidenav.value[0]
})

function toggleNav() {
  state.navOpen = !state.navOpen
}

function selectSection(key) {
  state.section = key
  state.navOpen = false
}

function close() {
  siteStore.overlay = ''
}

async function previewPublicProfile() {
  close()
  await nextTick()
  openProfilePopover({
    userId: userStore.id,
    anchor: document.querySelector('.account-avbtn') ?? document.body
  })
}

function onLogoutClick() {
  // -> Close first: logging out turns this reader into a guest, who has no profile, and the overlay
  //    would otherwise linger over whatever page the redirect lands on.
  close()
  userStore.logout()
}

onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
</script>

<style>
.layout-profile-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  /* -> Clips the header and body below to the panel's own rounded corners regardless of their own */
  /*    radius (or lack of one). Cobalt turns it back off below. */
  overflow: hidden;

  /*
    A plain div rather than a WCard, and a WCard is what declares BOTH halves of a surface: set only
    the background and everything inside keeps inheriting the document's black, invisible against
    the dark one.
  */
  .body--light & {
    background-color: var(--color-surface);
    color: var(--color-text-body);
  }
  .body--dark & {
    background-color: var(--color-dark-3);
    color: var(--color-text-dark);
  }

  /*
    Under Cobalt the header and body bands round and fill themselves (`MainLayout.vue`'s rules on
    the shared `.card-header` class), so a filled, clipping card around them would round the same
    curve a second time and leave an antialiasing fringe along it. In Ledger `--radius-dialog` is 0
    and this card still does real work, so the override is Cobalt-only.
  */
  .body--cobalt & {
    overflow: visible;
    background: transparent;
  }
}

.layout-profile-hdr {
  flex: 0 0 auto;
}

.layout-profile-body {
  flex: 1 1 auto;
  display: flex;
  align-items: stretch;
  /* -> The card above fills whatever the outer `MainOverlayDialog` panel gives it rather than */
  /*    growing with its content, so overflow has to scroll internally -- `.w-page` below is where */
  /*    that happens. */
  overflow: hidden;
}

.layout-profile-sd {
  flex: 0 0 300px;
  overflow-y: auto;

  .body--light & {
    background-color: var(--color-tint-alt);
    border-inline-end: 1px solid var(--color-hairline);
  }
  .body--dark & {
    background-color: var(--color-dark-4);
    border-inline-end: 1px solid var(--color-hairline-dark);
  }

  .w-list .w-item {
    /* -> One weight for every rail row, the current one included: the design marks that one with
       the bar and the colour instead */
    font-weight: 500;
    font-size: 13.5px;
    color: var(--color-slate);
    border-inline-start: 2px solid transparent;

    .body--dark & {
      color: var(--color-text-secondary-dark);
    }

    &.is-active {
      background-color: var(--color-surface);
      border-inline-start-color: var(--color-accent-fill);
      color: var(--color-accent);

      /* -> WIcon draws a build-inlined reference as an <svg> and a runtime one as <iconify-icon> */
      .w-icon,
      iconify-icon {
        color: var(--color-accent-fill);
      }

      .body--dark & {
        background-color: var(--color-dark-3);
        color: var(--color-text-dark);

        .w-icon,
        iconify-icon {
          color: var(--color-accent-dark);
        }
      }
    }
  }
}

.layout-profile-body .w-page {
  flex: 1 1;
  overflow-y: auto;

  /* -> No seam on this side: the rail already draws the one between the two columns */

  /*
    No padding at the top, so the first section band runs flush against the head of the column. The
    section pages carry no vertical padding of their own -- this is the single owner of it -- and
    the 24px foot also gives a section with no save bar something to stand on.
  */
  padding-block-end: 24px;
}

/*
  The settings-row rhythm, scoped to this overlay's content column rather than applied to `.w-item`
  / `.w-separator` themselves: both are shared library components with many callers, and what they
  draw elsewhere is the app's own rhythm, not something this one screen gets to move. Direct
  children only (`>`), so a nested list inside a section keeps the library metrics.
*/
.layout-profile-body .w-page > .w-item {
  padding: 14px 20px;
}

/*
  The plate's gutter, stated rather than inherited: the library's avatar section is a fixed column
  that centres the plate with slack either side, where the design measures edge-to-plate and
  plate-to-label separately. Collapsing the column onto the plate makes the trailing pad the gutter.
*/
.layout-profile-body .w-page > .w-item > .w-item-section--avatar {
  min-width: 0;
  padding-inline-end: 14px;
}

/*
  `--w-hairline-color` rather than a background: WSeparator paints its line through a scaled
  pseudo-element (`helpers/hairline.js`) so it stays one device pixel under fractional display
  scaling, and a `background-color` here would paint a second, unscaled line behind it.
*/
.layout-profile-body .w-page > .w-separator {
  margin-inline: 20px;
  --w-hairline-color: var(--color-tint);

  .body--dark & {
    --w-hairline-color: var(--color-hairline-dark);
  }
}

/*
  The save bar at the foot of a section: no fill, and the lighter `var(--color-tint)` rather than
  the `var(--color-hairline)` that separates two structural blocks -- the bar sits on the column's
  own ground rather than reading as a panel of its own.

  `16px 20px` rather than the design's `16px 20px 24px`: the trailing 24px is the content column's
  own `padding-block-end` above, so that a section with no save bar gets the same foot.
*/
.layout-profile-body .actions-bar {
  display: flex;
  justify-content: flex-end;
  padding: 16px 20px;
  border-top: 1px solid var(--color-tint);

  .body--dark & {
    border-top-color: var(--color-hairline-dark);
  }
}

/*
  The card gives up its fixed nav column at two widths rather than all at once: first the column
  shrinks to its own labels, then it becomes a disclosure above the content because even shrunk it
  is width the content needs more. Ordered narrowest-last, so each block overrides the one above it
  where they speak about the same property. Both are this component's own breakpoints, never shared
  app-wide ones: they describe when THIS card runs out of room, a function of its nav column alone.
*/

@media (max-width: 1199.98px) {
  .layout-profile-sd {
    flex: 0 0 auto;
  }
}

@media (max-width: 899.98px) {
  .layout-profile-body {
    flex-direction: column;
  }

  .layout-profile-navbtn {
    justify-content: space-between;

    .body--light & {
      background-color: var(--color-tint-alt);
      border-bottom: 1px solid var(--color-hairline);
    }
    .body--dark & {
      background-color: var(--color-dark-4);
      border-bottom: 1px solid var(--color-hairline-dark);
    }
  }

  /* -> WBtn wraps its content in a flex row of its own, so the chevron needs pushing to that end */
  /*    too, not only the button's */
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
    Per theme, not one unqualified override: the rules being replaced are declared per theme at a
    higher specificity, which a plain rule here would lose to.
  */
  .layout-profile-sd {
    flex: none;
    width: 100%;

    .body--light & {
      border-inline-end: 0;
      border-bottom: 1px solid var(--color-hairline);
    }
    .body--dark & {
      border-inline-end: 0;
      border-bottom: 1px solid var(--color-hairline-dark);
    }
  }
}
</style>
