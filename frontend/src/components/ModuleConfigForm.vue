<template>
  <template v-for="(cfg, cfgKey, idx) in config" :key="cfgKey">
    <template v-if="ifCheck(cfg.if)">
      <w-separator class="my-2" inset v-if="idx > 0" />
      <w-item v-if="cfg.type === `boolean`" tag="label">
        <blueprint-icon :icon="cfg.icon" :hue-rotate="cfg.readOnly ? -45 : 0" />
        <w-item-section>
          <w-item-label>{{ cfg.title }}</w-item-label>
          <w-item-label caption>{{ cfg.hint }}</w-item-label>
        </w-item-section>
        <w-item-section avatar>
          <w-toggle v-model="cfg.value" :aria-label="cfg.title" :disable="cfg.readOnly" />
        </w-item-section>
      </w-item>
      <w-item v-else>
        <blueprint-icon :icon="cfg.icon" :hue-rotate="cfg.readOnly ? -45 : 0" />
        <w-item-section>
          <w-item-label>{{ cfg.title }}</w-item-label>
          <w-item-label caption>{{ cfg.hint }}</w-item-label>
        </w-item-section>
        <w-item-section
          :style="cfg.type === `number` ? `flex: 0 0 150px;` : ``"
          :class="{ 'col-auto': cfg.enum && cfg.enumDisplay === `buttons` }">
          <w-btn-toggle
            v-if="cfg.enum && cfg.enumDisplay === `buttons`"
            v-model="cfg.value"
            push
            glossy
            no-caps
            toggle-color="primary"
            :options="cfg.enum"
            :disable="cfg.readOnly" />
          <w-select
            v-else-if="cfg.enum"
            outlined
            v-model="cfg.value"
            :options="cfg.enum"
            emit-value
            map-options
            dense
            options-dense
            :aria-label="cfg.title"
            :disable="cfg.readOnly" />
          <w-input
            v-else
            outlined
            v-model="cfg.value"
            dense
            :type="inputTypeFor(cfg)"
            :aria-label="cfg.title"
            :disable="cfg.readOnly" />
        </w-item-section>
      </w-item>
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
 * Mutates `config[key].value` in place rather than emitting: the object passed in is already the
 * caller's own reactive editable state (`AdminStorage.vue`'s `state.target.config`,
 * `AdminSearch.vue`'s `selectedEngine.config`), and a `v-model` on the prop as a whole would only be
 * that same object one indirection further away.
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

function ifCheck(ifs) {
  if (!ifs || ifs.length < 1) {
    return true
  }
  return ifs.every((s) => props.config[s.key]?.value === s.eq)
}
</script>
