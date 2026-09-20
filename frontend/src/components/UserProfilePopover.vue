<template>
  <teleport to="body">
    <div
      v-if="state.open"
      ref="panelEl"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="titleId"
      tabindex="-1"
      data-testid="user-profile-popover"
      class="user-profile-popover fixed overflow-auto rounded bg-[var(--color-white)] p-4 text-[var(--color-black)] shadow-menu dark:bg-dark-3 dark:text-white"
      :style="[floatStyle, { zIndex: POPOVER_Z }]"
      @keydown.tab="onTab">
      <w-btn
        class="user-profile-popover-close absolute end-1 top-1"
        icon="tabler:x"
        flat
        round
        dense
        size="sm"
        :aria-label="t(`common.actions.close`)"
        @click="closeProfilePopover" />

      <div class="flex items-start gap-3 pe-6">
        <w-avatar identity="initials" size="48px" font-size="16px">
          <img v-if="avatarSrc" :src="avatarSrc" alt="" width="48" height="48" />
          <span v-else>{{ initials(displayName) }}</span>
        </w-avatar>
        <div class="min-w-0 flex-1">
          <h2
            :id="titleId"
            class="user-profile-popover-name text-h6 m-0 [overflow-wrap:anywhere]"
            data-testid="user-profile-name">
            {{ displayName }}
          </h2>
        </div>
      </div>

      <div class="user-profile-popover-body mt-3" aria-live="polite">
        <div
          v-if="status === 'loading'"
          class="flex items-center gap-2 text-text-caption dark:text-text-caption-dark">
          <w-spinner size="16px" />
          <span>{{ t(`profilePopover.loading`) }}</span>
        </div>
        <p
          v-else-if="status !== 'ready'"
          class="user-profile-popover-error m-0 text-text-caption dark:text-text-caption-dark"
          data-testid="user-profile-error">
          {{ errorMessage }}
        </p>
        <dl v-else-if="shownFields.length > 0" class="m-0 flex flex-col gap-2">
          <div
            v-for="field in shownFields"
            :key="field.key"
            :data-testid="`user-profile-field-${field.key}`">
            <dt class="text-caption text-text-caption dark:text-text-caption-dark">
              {{ field.label }}
            </dt>
            <dd class="m-0 [overflow-wrap:anywhere]">{{ field.value }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { routeLocationKey } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { anchoredPosition } from '@/composables/anchoredPosition'
import { pushEscapeHandler } from '@/composables/escapeStack'
import {
  PROFILE_PUBLIC_FIELDS,
  closeProfilePopover,
  profilePopoverState as state
} from '@/composables/profilePopover'
import { initials } from '@/helpers/initials'

const POPOVER_Z = 6600

const { t } = useI18n()
const titleId = useId()

const panelEl = ref(null)
const floatStyle = ref({ left: '0px', top: '0px', width: '20rem', maxWidth: 'calc(100vw - 16px)' })

const profile = ref(null)
const status = ref('loading')

const displayName = computed(() => profile.value?.name || state.name || '')

const avatarSrc = computed(() => {
  if (!profile.value) {
    return null
  }
  if (profile.value.hasAvatar) {
    return `/_user/${profile.value.id}/avatar`
  }
  return profile.value.avatarProviderUrl || null
})

const FIELD_LABELS = computed(() => ({
  location: t(`profilePopover.fieldLocation`),
  jobTitle: t(`profilePopover.fieldJobTitle`),
  pronouns: t(`profilePopover.fieldPronouns`)
}))

const shownFields = computed(() =>
  PROFILE_PUBLIC_FIELDS.filter((key) => profile.value?.fields?.[key]).map((key) => ({
    key,
    label: FIELD_LABELS.value[key],
    value: profile.value.fields[key]
  }))
)

const errorMessage = computed(() => {
  switch (status.value) {
    case 'unauthorized':
      return t(`profilePopover.unauthorized`)
    case 'notFound':
      return t(`profilePopover.notFound`)
    default:
      return t(`profilePopover.failed`)
  }
})

let loadToken = 0

async function load(userId) {
  const token = ++loadToken
  profile.value = null
  status.value = 'loading'
  try {
    const data = await API_CLIENT.get(`users/${encodeURIComponent(userId)}/profile`).json()
    if (token !== loadToken) {
      return
    }
    profile.value = data
    status.value = 'ready'
  } catch (err) {
    if (token !== loadToken) {
      return
    }
    const code = err?.response?.status
    status.value = code === 401 ? 'unauthorized' : code === 404 ? 'notFound' : 'failed'
  }
}

async function reposition() {
  await nextTick()
  const panel = panelEl.value
  const anchor = state.anchor
  if (!panel || !anchor) {
    return
  }
  if (!anchor.isConnected) {
    closeProfilePopover()
    return
  }
  const { left, top } = anchoredPosition(
    anchor.getBoundingClientRect(),
    { width: panel.offsetWidth, height: panel.offsetHeight },
    { anchor: 'bottom left', self: 'top left', offset: [0, 6] }
  )
  floatStyle.value = { ...floatStyle.value, left: `${left}px`, top: `${top}px` }
  panel.style.maxHeight = `${window.innerHeight - 32}px`
}

function onTab(ev) {
  ev.preventDefault()
  panelEl.value?.querySelector('button')?.focus()
}

function onPointerDown(ev) {
  const target = ev.target
  if (panelEl.value?.contains(target) || state.anchor?.contains(target)) {
    return
  }
  closeProfilePopover()
}

let releaseEscape = null
let returnEl = null

function bind() {
  releaseEscape = pushEscapeHandler(() => {
    closeProfilePopover()
  })
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('scroll', reposition, { capture: true, passive: true })
}

function unbind() {
  releaseEscape?.()
  releaseEscape = null
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('resize', reposition)
  window.removeEventListener('scroll', reposition, { capture: true })
}

function restoreFocus() {
  const el = returnEl
  returnEl = null
  const active = document.activeElement
  const focusWasOurs =
    !active || active === document.body || active.closest?.('.user-profile-popover')
  if (focusWasOurs && el?.isConnected && typeof el.focus === 'function') {
    el.focus()
  }
}

watch(
  () => [state.open, state.seq],
  async ([open], [wasOpen]) => {
    if (open) {
      if (wasOpen) {
        unbind()
      }
      returnEl = state.anchor ?? returnEl ?? document.activeElement
      bind()
      load(state.userId)
      await reposition()
      panelEl.value?.focus()
    } else if (wasOpen) {
      loadToken += 1
      unbind()
      restoreFocus()
    }
  },
  { flush: 'post' }
)

watch(status, () => {
  if (state.open) {
    reposition()
  }
})

const route = inject(routeLocationKey, null)
watch(
  () => route?.fullPath,
  () => closeProfilePopover()
)

onBeforeUnmount(() => {
  loadToken += 1
  unbind()
})
</script>
