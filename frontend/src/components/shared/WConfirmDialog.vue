<template>
  <w-dialog
    v-model="dialogVisible"
    :persistent="effectivePersistent"
    :aria-label="title || null"
    @hide="onDialogHide">
    <w-card style="min-width: 380px; max-width: 480px">
      <!--
        `.card-header` (`css/_base.scss`) draws this band from the runtime `--color-dark-2` custom
        property, so it picks up `body.body--cobalt.body--dark`'s override (`#1a43bd`, wired by
        OpenProject #2771 specifically for "Confirm dialog header band" against
        `Primitives Dark 3x - Cobalt.dc.html`) same as every other aesthetic-aware surface. Every
        dialog in the app shares this same class for the same band (see `NavEditOverlay.vue`'s own
        comment on it), so the runtime-token swap is deliberately app-wide, not scoped to this
        component (OpenProject #2815, following up on #2772/#2773's frozen-primitive deferral).
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

        <!-- An identifier, a path, a count: the quiet detail under the question, as the page
             deletion dialog shows the page's ID. -->
        <div v-if="caption" class="w-confirm-caption mt-2">{{ caption }}</div>

        <!--
          The one prompting variant in the codebase: pick one of a few named choices. `onOk`
          receives the chosen value rather than `true`, which is what the import-mode prompt reads.
        -->
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
 * Confirm / prompt dialog.
 *
 * Opened through `confirm()` in `composables/dialog` rather than directly. It exists because the
 * library this replaces had built-in title/message dialogs, and while nearly every call site in the
 * app passes its own component, four do not -- three plain confirmations and one radio prompt.
 * Reimplementing those as four bespoke components would be worse than one shared one.
 */
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  /**
   * What is being confirmed. An array is rendered as one paragraph per entry, and `**like this**`
   * marks a run as bold — the one bit of emphasis these dialogs have ever needed, and cheaper than
   * a bespoke component per message.
   */
  message: {
    type: [String, Array],
    default: ''
  },
  /** A supporting detail, set smaller and greyer under the message. */
  caption: {
    type: String,
    default: ''
  },
  /**
   * Show a cancel button. Without it the dialog is an acknowledgement, not a choice. Defaults to
   * `true` -- acknowledgement-only is the rarer of the two shapes across the app's `confirm({…})`
   * call sites, so opting out (not in) is what most of them should have to spell.
   */
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
  /** Theme colour for the confirming button -- `negative` for a destructive action. */
  color: {
    type: String,
    default: 'primary'
  },
  /**
   * Do not close on a backdrop click or Escape. Only takes effect while a cancel button is also
   * shown (see `effectivePersistent`) -- a persistent dialog with no cancel button and no backdrop
   * escape would leave clicking OK as the only way out, silently committing whatever the dialog was
   * confirming.
   */
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
   * Shorthand for a destructive confirmation: negative-coloured OK, the delete label, and a cancel
   * button, all at once -- the combination every "delete this" dialog in the app otherwise has to
   * spell out as three separate props. Explicit `color`/`okLabel` still win when given.
   */
  destructive: {
    type: Boolean,
    default: false
  }
})

defineEmits(dialogComponentEmits)

// I18N

const { t } = useI18n()

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const paragraphs = computed(() => (Array.isArray(props.message) ? props.message : [props.message]))

/**
 * `destructive` forces a cancel button regardless of what `cancel` was given -- a destructive
 * confirmation must always offer a non-committal way out, never just the one button that commits it.
 */
const effectiveCancel = computed(() => props.cancel || props.destructive)

/**
 * `destructive` wins over the plain `primary` default, but an explicit non-default `color` (someone
 * deliberately picking a different theme colour) is left alone.
 */
const effectiveColor = computed(() =>
  props.destructive && props.color === 'primary' ? 'negative' : props.color
)

const effectiveOkLabel = computed(
  () => props.okLabel ?? (props.destructive ? t('common.actions.delete') : null)
)

/**
 * `persistent` only takes effect while a cancel button is actually shown. Without this, `persistent:
 * true` plus `cancel: false` (or omitted, pre-3.x-era default) left a dialog with no backdrop
 * escape, no Escape key, and no cancel button -- the only way out was clicking OK, silently
 * committing whatever the dialog was confirming. Rather than accept that combination as a valid,
 * reachable configuration, persistence is simply a no-op without a cancel button to serve as the
 * alternate way out: the dialog falls back to being dismissible via backdrop/Escape instead.
 */
const effectivePersistent = computed(() => props.persistent && effectiveCancel.value)

/**
 * A paragraph split into plain and bold runs.
 *
 * Split on `**`, so every odd piece is what sat between a pair. Returned as data for the template to
 * render as real elements rather than as markup handed to `v-html`: a confirmation message is often
 * built from a page title or a file name, and none of those can become HTML this way.
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
  Dialog typography (cobalt-typography.md §3, "Shared primitives" / "Dialog body", "Path field").
  Explicit rather than the Material `text-body2`/`text-caption` utilities these two used to carry --
  both pull in `@theme static`'s type scale, positive tracking included, which is the "Material scale
  reaching a Cardinal role" the audit forbids; the caption line was also drawing `text-grey`, a bare
  palette grey with no aesthetic awareness, rather than the semantic caption token every other quiet
  detail in the app reads.

  The colour pair (light `--color-ink`, dark `--color-text-dark`) mirrors `WCardHeader.vue`'s own
  `.w-card-header__action` -- `--color-ink` has no Cobalt-dark override of its own to fall back on,
  so the dark value is stated explicitly rather than assumed to follow from the token alone.
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

/* The quiet identifier/path/count under the message -- "Path field", cobalt-typography.md §3. */
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
