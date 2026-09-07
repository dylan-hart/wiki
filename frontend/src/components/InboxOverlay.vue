<template>
  <w-layout class="inbox-overlay" container>
    <w-header class="card-header">
      <w-icon name="tabler:inbox" left size="md" />
      <span>{{ t('inbox.title') }}</span>
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
    icon: 'tabler:inbox'
  },
  {
    key: 'review',
    label: t('inbox.pendingReview'),
    icon: 'tabler:clipboard-check'
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

  Written as `var(--color-*)` rather than the `$surface`/`$text-body`/`$dark-3`/`$text-dark` SCSS
  literals this used to read (OpenProject #2778, diffed against `Cardinal Wiki - Inbox 3x -
  Cobalt.dc.html`): those constants are Ledger-only (`css/_theme.scss`'s own header says so), so
  Cobalt light rendered this panel in Ledger's body text colour and Cobalt dark in Ledger's panel
  colour -- both silently wrong once `body--cobalt` is on `<body>`, since neither literal picks up
  `body.body--cobalt`'s `--color-text-body: #1a2038` or `body.body--cobalt.body--dark`'s
  `--color-dark-3: #141c4f` overrides. The custom properties resolve to the exact same values in
  Ledger (no visible change there), which is what makes this a pure token-layer fix rather than a new
  rule.
*/
.inbox-overlay {
  @at-root .body--light & {
    background-color: var(--color-surface);
    color: var(--color-text-body);
  }
  @at-root .body--dark & {
    background-color: var(--color-dark-3);
    color: var(--color-text-dark);
  }
}

/*
  The overlay's own section rail. Cardinal's tint, ruled off -- the same column the profile overlay
  and the file manager's folder tree draw, so the three overlays that have one all read alike.

  Cobalt (OpenProject #2778, `Cardinal Wiki - Inbox 3x - Cobalt.dc.html`) draws this rail as the
  site's own sidebar chrome rather than a light/dark-following tint -- background, row text/icon and
  the active item's fill all read off the exact tokens `HeaderNav.vue`'s sidebar-tinted mobile header
  (`--color-sidebar`) and `NavItemEditor.vue`'s Cobalt active row (`--color-sidebar-text`,
  `--color-sidebar-icon`, `--nav-active-inset`) already establish for this same "reader sidebar" role,
  and stay identical across the light/dark toggle -- the handoff's own dark-tokens section says the
  sidebar treatment "stays unchanged from Cobalt light", so one `body--cobalt` block below covers both.
*/
.inbox-overlay-sidebar {
  @at-root .body--light & {
    background-color: $tint-alt;
    border-inline-end: 1px solid $hairline;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-inline-end: 1px solid $hairline-dark;
  }
  @at-root .body--cobalt & {
    background-color: var(--color-sidebar);
    border-inline-end-color: var(--color-sidebar-hairline);
  }

  .w-list .w-item {
    /* -> Every rail row is set at 500, the current one included -- the design distinguishes them by
       the plate, the bar and the colour, not by weight */
    font-weight: 500;
    font-size: 13.5px;
    color: $slate;
    border-inline-start: 2px solid transparent;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }

    @at-root .body--cobalt & {
      color: var(--color-sidebar-text);

      .w-icon,
      iconify-icon {
        color: var(--color-sidebar-icon);
      }
    }

    /*
      The active section: lifted onto the panel's own white with an accent bar down its leading
      edge. The same mark the site sidebar, the folder tree and the file list all use for "you are
      here" -- where this used to be a two-stop wash of the brand colour, which is elevation drawn
      in paint.
    */
    &.is-active {
      background-color: $surface;
      border-inline-start-color: $accent-fill;
      color: $accent-text;

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

      /*
        Cobalt's active row is a plate, not a bordered strip: the handoff's radii sweep gives it
        `--radius-control` and a 10px side margin so it reads as a pill sitting on the rail rather
        than spanning it edge to edge, and the leading accent moves from a border to `--nav-active-
        inset`'s inset box-shadow -- the same shape `NavItemEditor.vue`'s own Cobalt active row
        already draws for the identical "selected sidebar item" role.
      */
      @at-root .body--cobalt & {
        background-color: var(--color-sidebar-active-bg);
        border-inline-start-color: transparent;
        border-radius: var(--radius-control);
        box-shadow: var(--nav-active-inset);
        color: var(--color-sidebar-active-text);
        margin-inline: 10px;

        .w-icon,
        iconify-icon {
          color: var(--color-sidebar-active-text);
        }
      }
    }
  }
}

/*
  The inbox's own row action: a 32x32 hairline square holding a 15px glyph and nothing else, which is
  how every action in both design files is drawn -- the notification's mark-read tick, the watched
  page's preferences and stop-watching pair, and the review toolbar's back/view/decline/approve set.
  Not the flat round `acrylic-btn` those all used to be: Cardinal separates a control from its ground
  with a hairline, never with a tint, and a round button is the one shape the language does not draw.

  Declared here rather than in either page because both of them use it and neither owns the other --
  `InboxOverlay` is the only thing that ever renders `InboxWatching`/`InboxReview`, so this is the one
  stylesheet guaranteed to be present wherever they are. It is deliberately NOT a `components/shared/`
  member: nothing outside this overlay draws it yet, and a third caller is when it earns promotion.

  `WBtn` writes its own `min-height`/`padding` as inline styles, so `padding="none"` is what actually
  zeroes the padding; only the width is left for a class to set. The glyph is sized at the call site
  (`<w-icon size="15px">`) for the same reason -- `WBtn`'s own `.w-icon` rule is scoped, and an inline
  font-size is the one thing that reliably beats it.
*/
.inbox-square-btn.w-btn {
  width: 32px;
}

/*
  Decline, the one action whose edge is not the neutral hairline: the design gives it the accent fill
  as a border with the darker accent as its glyph, so it reads as the refusal without being a filled
  red button sitting beside a filled green one.
*/
.inbox-square-btn--negative.w-btn {
  border-color: $accent-fill;

  @at-root .body--dark & {
    border-color: $accent-dark;
  }

  /*
    Cobalt's own accent-fill is `#ff4d5a`, not Ledger's `$accent-fill` (`#e4676b`) -- confirmed
    against both `Cardinal Wiki - Inbox Review 3x - Ledger.dc.html` and its Cobalt twin, whose only
    difference on this button is that one border colour. `--color-accent-fill` carries the same
    value in Cobalt light and dark (the handoff's dark-tokens section leaves it unrestated), so one
    rule after both Ledger blocks above covers both.
  */
  @at-root .body--cobalt & {
    border-color: var(--color-accent-fill);
  }
}

/*
  Diffed against the Cobalt pair (OpenProject #2778) and logged rather than fixed, since each needs a
  change outside this file's ownership:

  - `.card-header` (`css/_base.scss`) draws this overlay's own title band from the compile-time
    `theme.$dark-2` SCSS constant, never picking up `--color-dark-2`'s Cobalt override -- the same
    pre-existing, app-wide gap #2772/#2773 already logged for `WConfirmDialog.vue`'s identical band.
    Still `#1c2a70` in the Cobalt mockup vs whatever `$dark-2` renders as here.
  - The panel's own rounded/clipped `--radius-dialog` + `overflow:hidden` treatment (12px, no eyebrow
    bar) is `WDialog.vue`'s `rounded-lg` (a fixed Tailwind radius, not `--radius-dialog`) plus
    `MainLayout.vue`'s `.main-overlay > .w-dialog-panel` rule, which still draws Ledger's 10px ink
    eyebrow bar unconditionally -- the exact `--radius-dialog` gap #2772 already logged on `WDialog`.
    The 50%-viewport centering itself (`MainOverlayDialog.vue`'s `HALF_SIZE`, `MainLayout.vue`'s
    `.is-half-sized` floor) is unaffected and already correct in both aesthetics.
  - `<w-avatar square>`'s 36px plates (`InboxWatching.vue`/`InboxReview.vue`) render literally
    square in every aesthetic; the mockups round them to 6px (`--radius-control`) under Cobalt.
    `WAvatar.vue`'s `square` prop is a shared-component concern, not this file's.
  - The "slate" plate fill (the file-icon avatar in both pages) reads `--color-slate`, which Cobalt
    never redefines -- the mockups want `#1e2a5e` there (the handoff's "Commit"/"selected-tag fill"
    tone), a role with no token yet. `--color-accent-fill`'s plate is already correct, since Cobalt
    does redefine that one.
  - The diff editor's `cardinaljs` Monaco theme (`InboxReview.vue`) is deliberately literal hex,
    since Monaco cannot resolve a custom property -- but the two mockups' code panes are not
    identical either: gutter/label tones and the removed-line marker text shift between them
    (`#8792ab`/`#f08287` Ledger vs `#7f8ed1`/`#ff7a84` Cobalt) while the actual insert/remove line
    fills stay Ledger's raw `#5f9c86`/`#e4676b` in both files. Making the editor aesthetic-reactive
    (a second theme plus a watcher on `composables/aesthetic.js`) is a real feature addition, not a
    token swap, so it is left flagged rather than guessed at.
*/
</style>
