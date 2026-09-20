<template>
  <w-dialog
    v-model="dialogVisible"
    :persistent="effectivePersistent"
    :aria-label="title || null"
    @hide="onDialogHide">
    <w-card style="min-width: 380px; max-width: 480px">
      <!--
        The band's colour comes from `.card-header` (`css/_base.css`) off a runtime custom property
        every dialog in the app shares, so a per-theme override reaches all of them at once rather
        than being restated here.
      -->
      <w-card-section class="card-header">
        <span>{{ title }}</span>
      </w-card-section>
      <w-card-section>
        <div
          v-for="(paragraph, pIdx) of paragraphs"
          :key="pIdx"
          class="w-confirm-message"
          :class="pIdx > 0 ? 'mt-3' : ''">
          <template v-for="(run, rIdx) of runs(paragraph)" :key="rIdx">
            <strong v-if="run.strong">{{ run.text }}</strong>
            <template v-else>{{ run.text }}</template>
          </template>
        </div>

        <div v-if="caption" class="w-confirm-caption mt-2">{{ caption }}</div>

        <div v-if="options" class="mt-3 flex flex-col gap-1" role="radiogroup" :aria-label="title">
          <label
            v-for="item of options.items"
            :key="item.value"
            class="flex cursor-pointer items-center gap-2">
            <input v-model="choice" type="radio" :value="item.value" :name="groupName" />
            <span class="w-confirm-message">{{ item.label }}</span>
          </label>
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          v-if="effectiveCancel"
          class="acrylic-btn"
          flat
          :label="cancelLabel ?? t('common.actions.cancel')"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          :label="effectiveOkLabel ?? t('common.actions.ok')"
          :color="effectiveColor"
          padding="xs md"
          @click="onDialogOK(options ? choice : true)" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

/**
 * Opened through `confirm()` in `composables/dialog`, not mounted directly. It is the shared
 * stand-in for the plain confirmations and the one radio prompt that have no component of their own.
 */
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  /**
   * An array renders as one paragraph per entry, and `**like this**` marks a run as bold — the
   * only emphasis these dialogs need, and cheaper than a bespoke component per message.
   */
  message: {
    type: [String, Array],
    default: ''
  },
  caption: {
    type: String,
    default: ''
  },
  /** Without a cancel button the dialog is an acknowledgement, not a choice -- the rarer shape. */
  cancel: {
    type: Boolean,
    default: true
  },
  okLabel: {
    type: String,
    default: null
  },
  cancelLabel: {
    type: String,
    default: null
  },
  color: {
    type: String,
    default: 'primary'
  },
  /** Do not close on a backdrop click or Escape. Conditional -- see `effectivePersistent`. */
  persistent: {
    type: Boolean,
    default: false
  },
  /** `{ model, items: [{ label, value }] }` to prompt for one of several choices. */
  options: {
    type: Object,
    default: null
  },
  /**
   * Shorthand for negative-coloured OK + the delete label + a cancel button at once. Explicit
   * `color`/`okLabel` still win when given.
   */
  destructive: {
    type: Boolean,
    default: false
  }
})

defineEmits(dialogComponentEmits)

const { t } = useI18n()

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const paragraphs = computed(() => (Array.isArray(props.message) ? props.message : [props.message]))

/**
 * A destructive confirmation must always offer a non-committal way out, so it forces a cancel
 * button regardless of `cancel`.
 */
const effectiveCancel = computed(() => props.cancel || props.destructive)

/** `destructive` overrides only the `primary` default; a deliberately chosen colour is left alone. */
const effectiveColor = computed(() =>
  props.destructive && props.color === 'primary' ? 'negative' : props.color
)

const effectiveOkLabel = computed(
  () => props.okLabel ?? (props.destructive ? t('common.actions.delete') : null)
)

/**
 * Persistence is a no-op without a cancel button: no backdrop escape, no Escape key and no cancel
 * would leave OK as the only way out, silently committing whatever was being confirmed.
 */
const effectivePersistent = computed(() => props.persistent && effectiveCancel.value)

/**
 * Split on `**`, so every odd piece is what sat between a pair. Returned as data for the template
 * to render as real elements rather than markup handed to `v-html`: a message is often built from a
 * page title or a file name, and none of those can become HTML this way.
 */
function runs(paragraph) {
  return String(paragraph)
    .split('**')
    .map((text, idx) => ({ text, strong: idx % 2 === 1 }))
}

/** Radios need a name unique to this instance, or two open dialogs would share a group. */
const groupName = useId()
const choice = ref(props.options?.model ?? null)
</script>

<style scoped>
/*
  Spelled out rather than taking the `text-body2`/`text-caption` utilities: those pull in the
  Material type scale, positive tracking included, which no Cardinal role may inherit. The dark
  colour is stated too, since `--color-ink` has no dark override of its own to fall back on.
*/
.w-confirm-message {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.6;
  letter-spacing: normal;
  color: var(--color-ink);
}

:global(body.body--dark .w-confirm-message) {
  color: var(--color-text-dark);
}

.w-confirm-caption {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 400;
  letter-spacing: normal;
  color: var(--color-text-caption);
}

:global(body.body--dark .w-confirm-caption) {
  color: var(--color-text-caption-dark);
}
</style>
