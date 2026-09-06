<template>
  <w-menu
    ref="menu"
    class="translucent-menu"
    :anchor="props.anchor"
    :self="props.self"
    :offset="props.offset"
    @show="onShow">
    <!-- -> A fixed width: the levels slide sideways past each other, so a panel that resized to its
            contents would jump mid-slide. Long titles truncate instead. -->
    <div class="browse-menu-panel">
      <div class="browse-menu-header flex flex-nowrap items-center">
        <!-- -> The shared up-one-level plate (`UpOneLevelBtn.vue`), which owns the absent-at-the-root
                rule and the slide-in that keeps the title beside it moving with it rather than
                jumping. `acrylic-btn` is passed rather than baked in: this is the one of its three
                call sites that sits on a translucent surface. -->
        <up-one-level-btn
          :show="!isRoot"
          :disabled="state.isLoading"
          plate-class="acrylic-btn"
          @click="goUp" />
        <div class="min-w-0 flex-1">
          <!-- -> The root has no title of its own, and the site is already named in the sidebar
                  header directly above this, so there the path stands alone -->
          <div v-if="level.title" class="truncate text-sm font-medium">{{ level.title }}</div>
          <div class="text-caption truncate opacity-60 font-robotomono">/{{ state.path }}</div>
        </div>
      </div>
      <w-separator />
      <div class="browse-menu-track relative overflow-hidden">
        <!-- -> Absolute, so that showing it neither shifts the rows down nor re-anchors the panel -->
        <w-linear-progress
          v-if="state.isLoading"
          class="absolute inset-x-0 top-0 z-10"
          indeterminate
          size="2px" />
        <transition :name="`browse-menu-${state.direction}`">
          <div :key="state.path" class="browse-menu-level py-1">
            <div
              v-for="item of level.items"
              :key="item.path"
              class="browse-menu-row flex flex-nowrap items-stretch">
              <!--
                One row per name, whichever of the two kinds it is -- and both at once for a page
                that also has a folder of pages under it. There the label opens the page and the
                chevron beside it descends, so neither way in hides the other.
              -->
              <router-link
                v-if="item.isPage"
                class="browse-menu-target"
                :to="itemPath(item)"
                @click="menu?.hide()">
                <w-icon
                  :name="item.icon || `tabler:file-text`"
                  size="xs"
                  class="shrink-0 opacity-70" />
                <span class="truncate">{{ item.title }}</span>
              </router-link>
              <!-- -> The File Manager's folder, so a folder looks the same wherever the wiki draws
                      one. Full strength, unlike the line icons around it: it is a colour image, and
                      dimming it only washes the yellow out. -->
              <button v-else type="button" class="browse-menu-target" @click="descend(item)">
                <w-icon name="tabler:folder" size="xs" class="shrink-0" />
                <span class="truncate">{{ item.title }}</span>
                <w-space />
                <w-icon name="tabler:chevron-right" size="xs" class="shrink-0 opacity-40" />
              </button>
              <button
                v-if="item.isPage && item.isFolder"
                type="button"
                class="browse-menu-into"
                :aria-label="t(`common.browse.openFolder`, { title: item.title })"
                @click="descend(item)">
                <w-tooltip>{{ t('common.browse.openFolder', { title: item.title }) }}</w-tooltip>
                <w-icon name="tabler:chevron-right" size="xs" class="opacity-70" />
              </button>
            </div>
            <div v-if="level.items.length < 1" class="browse-menu-note">
              {{ t('common.browse.empty') }}
            </div>
            <div v-if="level.truncated" class="browse-menu-note">
              {{ t('common.browse.truncated') }}
            </div>
          </div>
        </transition>
      </div>
    </div>
  </w-menu>
</template>

<script setup>
import { computed, nextTick, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import UpOneLevelBtn from './UpOneLevelBtn.vue'

/**
 * The sidebar's Browse menu: one folder of the site at a time, as a reader walks it.
 *
 * Opens on the folder holding the page being read, and slides a level sideways on the way in or out
 * rather than nesting submenus -- a wiki tree is deep, and cascading panels would run off the screen
 * a couple of levels down.
 *
 * What it lists comes from `tree/browse`, which decides what a reader may see; nothing here filters,
 * so there is no version of this menu that shows more than the server was willing to hand over.
 */

// PROPS

const props = defineProps({
  anchor: {
    type: String,
    default: 'bottom left'
  },
  self: {
    type: String,
    default: 'top left'
  },
  offset: {
    type: Array,
    default: () => [0, 0]
  }
})

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// REFS

const menu = ref(null)

// DATA

const EMPTY_LEVEL = { title: '', items: [], truncated: false }

const state = reactive({
  /** Slash-separated path of the folder being listed. Empty at the site root. */
  path: '',
  /** Which way the next level slides in from. */
  direction: 'forward',
  isLoading: false,
  /** Levels already fetched, by path, so that walking back up is instant. */
  levels: {}
})

// COMPUTED

const level = computed(() => state.levels[state.path] ?? EMPTY_LEVEL)

const isRoot = computed(() => !state.path)

// METHODS

/** Opens on the folder holding the current page, with whatever was cached from last time dropped. */
function onShow() {
  state.levels = {}
  state.direction = 'forward'
  state.path = pageStore.folderPath
  load(state.path)
}

/*
  Which fetch is the current one. Reopening the menu drops the cache and asks again, so a request
  from the previous open can still land afterwards — and it must not be the one that decides the
  progress bar is finished. The level it writes is keyed by its own path, so it is harmless otherwise.
*/
let latestRequest = 0

async function load(path) {
  if (state.levels[path]) {
    return true
  }
  const request = ++latestRequest
  state.isLoading = true
  try {
    const data = await API_CLIENT.get(`sites/${siteStore.id}/tree/browse`, {
      searchParams: {
        path,
        locale: pageStore.locale
      }
    }).json()
    state.levels[path] = {
      title: data.title ?? '',
      items: data.items ?? [],
      truncated: Boolean(data.truncated)
    }
    return true
  } catch (err) {
    notify({
      type: 'negative',
      message: t('common.browse.loadFailed'),
      caption: apiErrorMessage(err)
    })
    return false
  } finally {
    if (request === latestRequest) {
      state.isLoading = false
    }
  }
}

/**
 * Moves to another level: the contents are fetched first, so the slide reveals the rows already in
 * place rather than an empty panel that fills in afterwards.
 */
async function moveTo(path, direction) {
  if (state.isLoading || path === state.path) {
    return
  }
  if (!(await load(path))) {
    return
  }
  state.direction = direction
  state.path = path
  // -> The panel is anchored by its top edge, and a level of a different length moves the other one
  await nextTick()
  menu.value?.updatePosition()
}

function descend(item) {
  moveTo(item.path, 'forward')
}

/**
 * The route to a listed page. Every level of this menu is fetched at `pageStore.locale` (see `load`),
 * so that is the locale every row in it belongs to, not necessarily the site's primary one.
 */
function itemPath(item) {
  return localizedPagePath(item.path, pageStore.locale, siteStore.localeRouting)
}

function goUp() {
  moveTo(state.path.split('/').slice(0, -1).join('/'), 'back')
}
</script>

<style scoped lang="scss">
.browse-menu-panel {
  width: 270px;
}

/*
  A fixed height, because the header's contents are not the same on every level: the root has no
  title line and no up button, and letting the row size itself moved everything below it by the
  difference each time a level changed. 52px is the two lines it holds at most -- a 20px title and a
  20px path -- plus the space around them.

  That leaves 12px above and below the 28px plate, which is where the 12px beside it comes from: the
  gap around it reads as even only if all four sides match. The left one is this padding, the right
  one is the plate's own trailing margin, which `UpOneLevelBtn.vue` owns along with the rest of it.
*/
.browse-menu-header {
  height: 52px;
  padding: 0 8px 0 12px;
}

.browse-menu-target {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  text-align: start;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}

/*
  The page being read, marked without a line of script: a `router-link` to the current route carries
  `router-link-exact-active` itself, and the menu opens on that page's own folder — so it is normally
  one of the rows on screen.
*/
.browse-menu-target.router-link-exact-active {
  color: var(--color-primary);
  font-weight: 500;

  @at-root .body--dark & {
    color: var(--color-primary-light);
  }
}

.browse-menu-into {
  display: flex;
  align-items: center;
  padding: 0 10px;
  cursor: pointer;
  /* -> The seam that says the row has two hit targets rather than one */
  border-inline-start: 1px solid rgb(0 0 0 / 0.08);

  @at-root .body--dark & {
    border-inline-start-color: rgb(255 255 255 / 0.12);
  }
}

/* Same tints WItem uses, so a row here feels like a row anywhere else */
.browse-menu-target,
.browse-menu-into {
  &:hover {
    background-color: rgb(0 0 0 / 0.08);
  }
  &:active {
    background-color: rgb(0 0 0 / 0.14);
  }

  @at-root .body--dark & {
    &:hover {
      background-color: rgb(255 255 255 / 0.14);
    }
    &:active {
      background-color: rgb(255 255 255 / 0.22);
    }
  }
}

.browse-menu-note {
  padding: 8px 12px;
  font-size: 12px;
  opacity: 0.6;
}

/*
  The slide.

  The incoming level stays in flow, so the panel takes its height immediately; the outgoing one is
  taken out of flow for the duration, which is what lets the two overlap while they cross.
*/
.browse-menu-level {
  width: 100%;
}

.browse-menu-forward-enter-active,
.browse-menu-forward-leave-active,
.browse-menu-back-enter-active,
.browse-menu-back-leave-active {
  transition:
    transform 0.18s var(--ease-standard),
    opacity 0.18s var(--ease-standard);
}

.browse-menu-forward-leave-active,
.browse-menu-back-leave-active {
  position: absolute;
  top: 0;
  inset-inline-start: 0;
}

.browse-menu-forward-enter-from,
.browse-menu-back-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.browse-menu-forward-leave-to,
.browse-menu-back-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .browse-menu-forward-enter-active,
  .browse-menu-forward-leave-active,
  .browse-menu-back-enter-active,
  .browse-menu-back-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
