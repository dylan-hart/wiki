<template>
  <template v-for="(cfg, cfgKey) in config" :key="cfgKey">
    <template v-if="ifCheck(cfg.if)">
      <w-settings-row
        v-if="cfg.type === `boolean`"
        :tag="cfg.readOnly ? `div` : `label`"
        control-width="auto"
        :icon="iconFor(cfg)"
        :label="cfg.title">
        <template #hint>
          <span :class="cfg.readOnly ? `text-orange` : ``">{{ cfg.hint }}</span>
        </template>
        <w-toggle v-model="cfg.value" :aria-label="cfg.title" :disabled="cfg.readOnly" />
      </w-settings-row>
      <w-settings-row
        v-else
        :control-width="controlWidthFor(cfg)"
        :icon="iconFor(cfg)"
        :label="cfg.title">
        <template #hint>
          <span :class="cfg.readOnly ? `text-orange` : ``">{{ cfg.hint }}</span>
        </template>
        <w-btn-toggle
          v-if="cfg.enum && cfg.enumDisplay === `buttons`"
          v-model="cfg.value"
          toggle-color="primary"
          :aria-label="cfg.title"
          :options="cfg.enum"
          :disabled="cfg.readOnly" />
        <w-select
          v-else-if="cfg.enum"
          v-model="cfg.value"
          :options="cfg.enum"
          emit-value
          map-options
          dense
          options-dense
          :aria-label="cfg.title"
          :disabled="cfg.readOnly" />
        <w-input
          v-else
          v-model="cfg.value"
          dense
          :type="inputTypeFor(cfg)"
          :autocomplete="cfg.sensitive ? 'new-password' : null"
          :aria-label="cfg.title"
          :disabled="cfg.readOnly" />
      </w-settings-row>
    </template>
  </template>
</template>

<script setup>
/**
 * One field per prop of a module's config, in the shape `buildConfigEditor()`
 * (`@/helpers/moduleConfig.js`) produces: boolean -> toggle, `enum` -> select or button-group (per
 * `enumDisplay`), `sensitive` -> password input, `readOnly` -> disabled, `if` -> conditional
 * visibility against a sibling prop's current value.
 *
 * A `readOnly` prop is drawn as a plain `div` rather than a `label` (a label whose control cannot be
 * operated is a click target that does nothing) and its hint is set in orange, since that hint is
 * where the module explains WHY the value is fixed. Both come from `AdminAuth.vue`'s own copy of
 * this template, which is the only one that had them; adopting them unconditionally is harmless for
 * a module with no read-only props and is what let the other three pages move onto this form.
 *
 * Mutates `config[key].value` in place rather than emitting: the object passed in is already the
 * caller's own reactive editable state (`AdminStorage.vue`'s `state.target.config`,
 * `AdminSearch.vue`'s `selectedEngine.config`), and a `v-model` on the prop as a whole would only be
 * that same object one indirection further away.
 *
 * A `sensitive` field gets `autocomplete="new-password"` (input or textarea alike, since
 * `sshPrivateKeyContent` is `sensitive` and `multiline`), matching `HeaderSearch.vue`'s existing use
 * of `autocomplete` to stop a bare field from being treated as a login field (OpenProject #830) --
 * without it a `type="password"` field like S3's secret key or Git's PAT draws password-manager
 * autofill scanning it has no business doing on a config field.
 *
 * Each prop is a `WSettingsRow` (Wiki #2700), so a module's config form is the same 34px-plate,
 * label-over-hint, control-at-the-trailing-edge row as every hand-written settings row on the five
 * pages that mount this -- Analytics, Auth, Comments, Search and Storage. That also retired the
 * `<w-separator v-if="idx > 0">` this used to emit between fields: the row draws its own rule as a
 * `border-top` on `.w-settings-row + .w-settings-row`, which is an adjacent-SIBLING match, so a
 * field hidden by its `if` condition can no longer leave a rule stranded above nothing. The caller
 * supplies the `WSettingsCard` around these rows.
 *
 * `controlWidthFor` keeps the two width exceptions the `WItemSection` markup carried inline: a
 * number field is a narrow column rather than a full-width one, and a button group sizes to its own
 * options instead of being stretched.
 *
 * Extracted (task #556) from what had been two independently-maintained, byte-for-byte-identical
 * copies of this same template block: `AdminStorage.vue`'s own target config editor, and
 * `AdminSearch.vue`'s port of it (task #571/#572, whose own comments flagged the duplication as a
 * deferred follow-up). A module with nothing configurable renders nothing -- the caller is
 * responsible for a "nothing to configure" message, the same way `AdminStorage.vue` and
 * `AdminSearch.vue` each already show one of their own for the empty case.
 */

// PROPS

const props = defineProps({
  /** Keyed by prop name; each entry is a `ModuleProp` (see `helpers/common.ts`) plus a mutable `.value`. */
  config: {
    type: Object,
    required: true
  }
})

// METHODS

function inputTypeFor(cfg) {
  if (cfg.multiline) {
    return 'textarea'
  }
  if (cfg.sensitive) {
    return 'password'
  }
  return cfg.type === 'number' ? 'number' : 'text'
}

/**
 * How wide the control at the trailing edge sits. A button group has a width of its own and reads
 * wrong stretched (`auto`); a number is a short value and took a 150px column here before, which is
 * `fixed`'s 200px now that the width is one of the row's three documented choices rather than an
 * inline style; everything else -- a select, a text or password field, a textarea -- is a field and
 * wants the space (`grow`, the default).
 */
/**
 * The plate's glyph.
 *
 * A module prop's `icon` in its `definition.yml` is still a 2.x asset name -- `key`, `tune`,
 * `geography`, `open-box` -- from the `ultraviolet-*` illustration set that no longer exists, and
 * `WIcon` resolves anything without a set prefix to `kind: 'none'`, so every one of them draws an
 * empty plate. Rather than leave a blank square at the head of each row, an unprefixed name falls
 * back to a generic settings glyph until the six module kinds' `definition.yml` files are
 * re-pointed at Tabler references (raised as a finding on Wiki #2700; it is a backend sweep, not a
 * frontend one). A real `prefix:name` reference is used as written.
 */
function iconFor(cfg) {
  return /^[a-z0-9]+(-[a-z0-9]+)*:/.test(cfg.icon ?? '')
    ? cfg.icon
    : 'tabler:adjustments-horizontal'
}

function controlWidthFor(cfg) {
  if (cfg.enum && cfg.enumDisplay === 'buttons') {
    return 'auto'
  }
  return cfg.type === 'number' ? 'fixed' : 'grow'
}

function ifCheck(ifs) {
  if (!ifs || ifs.length < 1) {
    return true
  }
  return ifs.every((s) => props.config[s.key]?.value === s.eq)
}
</script>
