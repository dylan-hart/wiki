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
      <inbox-pages v-else-if="tab === 'pages'" />
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

import InboxPages from '@/pages/InboxPages.vue'
import InboxReview from '@/pages/InboxReview.vue'
import InboxWatching from '@/pages/InboxWatching.vue'

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('Inbox', opts)`): `tab`
 * picks which of the two sections opens; `submissionId`/`from` are `InboxReview`'s own initial
 * state, passed straight through.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

const siteStore = useSiteStore()

const { t } = useI18n()

// -> A computed, not an array evaluated once at setup: those `t()` calls would freeze these labels
//    in whatever language was active when the overlay mounted.
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
  },
  {
    key: 'pages',
    label: t('inbox.pages'),
    icon: 'tabler:history'
  }
])

const TABS = ['watching', 'review', 'pages']

const tab = ref(TABS.includes(props.overlayOpts.tab) ? props.overlayOpts.tab : 'watching')

function close() {
  siteStore.$patch({ overlay: '' })
}
</script>

<style>
/*
  A foreground declared alongside the background: `w-layout` is a plain div, not a `WCard` (the one
  component that declares both halves of a surface itself), so without an explicit `color` every
  label under `InboxWatching.vue`/`InboxReview.vue` inherits the document's default black -- fine in
  light mode by accident, illegible against this overlay's dark background.
*/
.inbox-overlay {
  .body--light & {
    background-color: var(--color-surface);
    color: var(--color-text-body);
  }
  .body--dark & {
    background-color: var(--color-dark-3);
    color: var(--color-text-dark);
  }
}

/*
  Under Cobalt this rail is the site's own sidebar chrome rather than a light/dark-following tint,
  so it reads off the `--color-sidebar*` tokens and stays identical across the light/dark toggle --
  which is why one `body--cobalt` block covers both themes.
*/
.inbox-overlay-sidebar {
  .body--light & {
    background-color: var(--color-tint-alt);
    border-inline-end: 1px solid var(--color-hairline);
  }
  .body--dark & {
    background-color: var(--color-dark-4);
    border-inline-end: 1px solid var(--color-hairline-dark);
  }
  .body--cobalt & {
    background-color: var(--color-sidebar);
    border-inline-end-color: var(--color-sidebar-hairline);
  }

  .w-list .w-item {
    /* -> The active row is not bolded: the plate, the bar and the colour distinguish it */
    font-weight: 500;
    font-size: 13.5px;
    color: var(--color-slate);
    border-inline-start: 2px solid transparent;

    .body--dark & {
      color: var(--color-text-secondary-dark);
    }

    .body--cobalt & {
      color: var(--color-sidebar-text);

      .w-icon,
      iconify-icon {
        color: var(--color-sidebar-icon);
      }
    }

    &.is-active {
      background-color: var(--color-surface);
      border-inline-start-color: var(--color-accent-fill);
      color: var(--color-accent);

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

      /*
        Cobalt's active row is a pill sitting on the rail, not a strip spanning it: hence the radius
        and side margin, and the leading accent moving from a border to an inset shadow.
      */
      .body--cobalt & {
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
  The row action both pages draw. Declared here because neither page owns the other and this overlay
  is the only thing that renders either, so this stylesheet is guaranteed present wherever they are;
  it is deliberately not a `components/shared/` member until a caller outside this overlay wants it.

  `WBtn` writes its own `min-height`/`padding` as inline styles, so `padding="none"` at the call site
  is what zeroes the padding and only the width is left for a class. The glyph is sized inline at the
  call site for the same reason -- `WBtn`'s own `.w-icon` rule otherwise wins.
*/
.inbox-square-btn.w-btn {
  width: 32px;
}

/*
  Decline, the one action whose edge is not the neutral hairline: an accent-fill border rather than a
  filled red button sitting beside a filled green one. `--color-accent-fill` already carries each
  aesthetic's own value, and only Ledger's dark theme lightens it -- hence the single override.
*/
.inbox-square-btn--negative.w-btn {
  border-color: var(--color-accent-fill);

  .body--dark:not(.body--cobalt) & {
    border-color: var(--color-accent-dark);
  }
}
</style>
