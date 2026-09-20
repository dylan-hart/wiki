<template>
  <w-card class="icon-picker" style="width: 460px">
    <!-- -> Inset: the strip has a track of its own, so it sits ON the card rather than spanning it -->
    <w-tabs class="m-2" v-model="state.currentTab" no-caps inline-label>
      <w-tab name="icon" icon="tabler:icons" :label="t(`iconPicker.icons`)" />
      <w-tab
        v-if="!props.noImage"
        name="image"
        icon="tabler:photo"
        :label="t(`iconPicker.image`)" />
    </w-tabs>
    <w-separator />
    <w-tab-panels v-model="state.currentTab">
      <w-tab-panel class="p-2" name="icon">
        <div class="flex flex-wrap gap-2">
          <div class="min-w-0 flex-1">
            <w-input
              ref="iptSearch"
              v-model="state.query"
              dense
              clearable
              :label="t(`iconPicker.search`)"
              :aria-label="t(`iconPicker.search`)"
              @update:model-value="queueSearch">
              <template #prepend><w-icon name="tabler:search" /></template>
            </w-input>
          </div>
          <div class="flex-none">
            <w-select
              v-model="state.setFilter"
              :options="setOptions"
              dense
              options-dense
              emit-value
              map-options
              style="min-width: 130px"
              :label="t(`iconPicker.set`)"
              :aria-label="t(`iconPicker.set`)"
              @update:model-value="onSetFilterChange" />
          </div>
        </div>
        <div class="icon-picker-results mt-2">
          <!-- -> No spinner in the slot: WInnerLoading draws its own, and the slot is for what goes
               BESIDE it (a caption). Passing one gives two stacked spinners. -->
          <w-inner-loading :showing="state.loading" size="32px" />
          <div
            class="text-center text-caption text-grey p-6"
            v-if="!state.loading && state.results.length < 1">
            {{ state.query?.length >= 2 ? t('iconPicker.noResults') : t('iconPicker.searchHint') }}
          </div>
          <div class="icon-picker-grid" v-else>
            <w-btn
              class="icon-picker-cell"
              v-for="icon of state.results"
              :key="icon"
              flat
              dense
              :class="{ 'icon-picker-cell--active': state.selected === icon }"
              :aria-label="icon"
              @click="state.selected = icon">
              <w-icon :name="icon" size="24px" />
              <w-tooltip>{{ icon }}</w-tooltip>
            </w-btn>
          </div>
        </div>
      </w-tab-panel>
      <w-tab-panel v-if="!props.noImage" class="p-3" name="image">
        <!-- -> `text-grey` is too faint to read at caption size; the app's secondary-text pair holds
             up on both the light panel and the dark one -->
        <div class="text-caption text-black/60 dark:text-white/70">
          {{ t('iconPicker.imageHint') }}
        </div>
        <!--
          The field holds the path alone; the `img:` that marks it as an image is a fixed prefix,
          added on the way out. WIcon needs the reference stored that way, but nobody should have to
          know to type it.
        -->
        <w-input
          ref="iptImage"
          class="mt-4"
          v-model="state.image"
          dense
          prefix="img:"
          :label="t(`iconPicker.imageUrl`)"
          :aria-label="t(`iconPicker.imageUrl`)"
          placeholder="/_assets/icons/my-icon.svg" />
        <div class="mt-4 text-caption text-black/60 dark:text-white/70">
          {{ t('iconPicker.imageSizeHint') }}
        </div>
      </w-tab-panel>
    </w-tab-panels>
    <w-separator />
    <w-card-section class="flex flex-wrap items-center py-2">
      <w-avatar size="40px" rounded :color="dark.isActive ? `dark-3` : `grey-2`">
        <w-icon :name="pendingValue" size="28px" color="primary" />
      </w-avatar>
      <div class="min-w-0 flex-1 ps-2">
        <div class="text-caption text-grey">{{ t('iconPicker.selection') }}</div>
        <div class="text-body2 icon-picker-ref">{{ pendingValue || '—' }}</div>
      </div>
    </w-card-section>
    <w-separator />
    <w-card-actions>
      <w-space />
      <w-btn
        icon="tabler:x"
        :label="t(`common.actions.discard`)"
        outline
        color="grey-7"
        @click="closePopup()" />
      <w-btn
        icon="tabler:check"
        :label="t(`common.actions.apply`)"
        color="slate"
        :disabled="!pendingValue"
        @click="applyAndClose" />
    </w-card-actions>
  </w-card>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { notify } from '@/composables/notify'
import { useDark } from '@/composables/dark'

import { debounce } from 'es-toolkit/function'
import { useClosePopup } from '@/composables/popup'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { useUserStore } from '@/stores/user'

const { t } = useI18n()

const closePopup = useClosePopup()

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  /**
   * For callers whose value has no `img:` form to fall back on -- the markdown editor writes an
   * `:tabler:home:` shortcode, which is an Iconify reference and nothing else.
   */
  noImage: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

/** This app's own icons are all `tabler:*`, and it is the most complete single set to land a
 *  first-time search in rather than a firehose of every enabled set at once. */
const DEFAULT_SET_FILTER = 'tabler'

const state = reactive({
  currentTab: 'icon',
  query: '',
  setFilter: DEFAULT_SET_FILTER,
  sets: [],
  results: [],
  selected: '',
  image: '',
  loading: false
})

const ICONIFY_REF = /^[a-z0-9-]+:[a-z0-9.-]+$/

const IMAGE_PREFIX = 'img:'

const iptSearch = ref(null)
const iptImage = ref(null)

const userStore = useUserStore()

const dark = useDark()

const setOptions = computed(() => {
  return [
    { value: '', label: t('iconPicker.allSets') },
    ...state.sets.map((set) => ({ value: set.prefix, label: set.name }))
  ]
})

const pendingValue = computed(() => {
  if (state.currentTab !== 'image') {
    return state.selected
  }
  const url = state.image?.trim()
  return url ? `${IMAGE_PREFIX}${url}` : ''
})

watch(() => state.currentTab, focusCurrentTab)

async function loadSets() {
  try {
    // -> A disabled set is not searchable, and its icons cannot be stored
    const sets = await API_CLIENT.get('icons/sets').json()
    state.sets = (sets ?? []).filter((set) => set.isEnabled)
    // -> The default or persisted filter may name a set this instance has since disabled -- fall
    //    back to "every enabled set" rather than searching one that can never return a result.
    if (state.setFilter && !state.sets.some((set) => set.prefix === state.setFilter)) {
      state.setFilter = ''
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('iconPicker.setsFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function search() {
  const query = state.query?.trim()
  if (!query || query.length < 2) {
    state.results = []
    return
  }

  state.loading = true
  try {
    const params = new URLSearchParams({ query })
    if (state.setFilter) {
      params.set('prefixes', state.setFilter)
    }
    const resp = await API_CLIENT.get(`icons/search?${params}`).json()
    state.results = resp?.icons ?? []
  } catch (err) {
    // -> The backend already degrades to locally-materialized icons when offline or when Iconify is
    //    unreachable, so a genuine error here is rare and still not worth a toast -- the template
    //    shows an empty-results state whenever `state.results` is empty and not loading.
    state.results = []
    log.warn('dialog', 'icon search failed', err)
  }
  state.loading = false
}

// -> Every keystroke would otherwise be a search against the upstream API
const queueSearch = debounce(search, 350)

async function loadSetPref() {
  if (!userStore.authenticated) {
    return
  }
  try {
    const resp = await API_CLIENT.get('users/profile').json()
    const saved = resp?.iconPicker?.set
    if (saved !== undefined) {
      state.setFilter = saved
    }
  } catch (err) {
    log.warn('dialog', 'could not load persisted icon picker set preference', err)
  }
}

/** A failed save is swallowed: losing this preference is not worth interrupting the icon search. */
async function saveSetPref() {
  if (!userStore.authenticated) {
    return
  }
  try {
    await API_CLIENT.put('users/profile', { json: { iconPicker: { set: state.setFilter } } }).json()
  } catch (err) {
    log.warn('dialog', 'could not save icon picker set preference', err)
  }
}

/** Named, because oxfmt breaks a two-statement inline handler onto separate lines */
function onSetFilterChange() {
  search()
  saveSetPref()
}

/**
 * Materializing here covers a reference that was typed rather than picked (drawing the results
 * already stored those), so from the moment content points at an icon it is served by the wiki,
 * with or without the Iconify API.
 */
async function apply() {
  const value = pendingValue.value
  emit('update:modelValue', value)

  // -> An image is served from wherever it points; only an icon has to be stored
  if (value.startsWith(IMAGE_PREFIX) || !ICONIFY_REF.test(value)) {
    return
  }
  try {
    await API_CLIENT.post('icons/materialize', { json: { icons: [value] } }).json()
  } catch (err) {
    // -> The reference is saved either way; it just may not render until the icon can be fetched
    notify({
      type: 'warning',
      message: t('iconPicker.materializeFailed', { icon: value }),
      caption: apiErrorMessage(err)
    })
  }
}

/** Named, because oxfmt breaks a two-statement inline handler onto separate lines */
function applyAndClose() {
  apply()
  closePopup()
}

/**
 * Two ticks: the first renders the tab switch, and the field only exists once the panel it lives in
 * is the visible one.
 */
async function focusCurrentTab() {
  await nextTick()
  await nextTick()
  ;(state.currentTab === 'image' ? iptImage : iptSearch).value?.focus()
}

onMounted(async () => {
  if (!props.noImage && props.modelValue?.startsWith(IMAGE_PREFIX)) {
    state.currentTab = 'image'
    state.image = props.modelValue.slice(IMAGE_PREFIX.length)
  } else if (ICONIFY_REF.test(props.modelValue ?? '')) {
    state.selected = props.modelValue
    state.results = [props.modelValue]
  }

  // -> An `img:` value above may already have moved the tab, in which case the watcher is focusing
  //    the same field and this call is a no-op
  await focusCurrentTab()

  await loadSetPref()
  await loadSets()
})
</script>

<style>
.body--light .icon-picker a {
  color: var(--color-blue-7);
}
.body--dark .icon-picker a {
  color: var(--color-blue-3);
}
.icon-picker {
  /* -> A shade off the card, so the fields and results read as sitting on a surface */
}
.body--light .icon-picker .w-tab-panels {
  background-color: var(--color-grey-1);
}
.body--dark .icon-picker .w-tab-panels {
  background-color: var(--color-dark-4);
}
.icon-picker-results {
  position: relative;
  height: 220px;
  overflow-y: auto;
}
.body--light .icon-picker-results {
  background-color: #fff;
}
.body--dark .icon-picker-results {
  background-color: var(--color-dark-5);
}
.icon-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 2px;
  padding: 4px;
}
.icon-picker-cell {
  height: 44px;
}
.body--light .icon-picker-cell--active {
  background-color: var(--color-blue-1);
}
.body--dark .icon-picker-cell--active {
  background-color: var(--color-blue-9);
}
.icon-picker-ref {
  font-family: monospace;
  word-break: break-all;
}
</style>
