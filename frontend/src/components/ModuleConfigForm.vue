<template>
  <template v-for="(cfg, cfgKey) in config" :key="cfgKey">
    <template v-if="ifCheck(cfg.if)">
      <w-settings-row
        v-if="cfg.type === `boolean`"
        :tag="cfg.readOnly ? `div` : `label`"
        control-width="auto"
        :icon="cfg.icon"
        :label="cfg.title">
        <template #hint>
          <span :class="cfg.readOnly ? `text-orange` : ``">{{ cfg.hint }}</span>
        </template>
        <w-toggle v-model="cfg.value" :aria-label="cfg.title" :disabled="cfg.readOnly" />
      </w-settings-row>
      <w-settings-row
        v-else
        :control-width="controlWidthFor(cfg)"
        :icon="cfg.icon"
        :label="cfg.title">
        <template #hint>
          <span :class="cfg.readOnly ? `text-orange` : ``">{{ cfg.hint }}</span>
        </template>
        <w-btn-toggle
          v-if="cfg.enum && cfg.enumDisplay === `buttons`"
          v-model="cfg.value"
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
 * (`@/helpers/moduleConfig.js`) produces.
 *
 * A `readOnly` prop is drawn as a plain `div` rather than a `label`, since a label whose control
 * cannot be operated is a click target that does nothing, and its hint is set in orange, since that
 * hint is where the module explains WHY the value is fixed.
 *
 * Mutates `config[key].value` in place rather than emitting: the object passed in is already the
 * caller's own reactive editable state, and a `v-model` on the prop as a whole would only be that
 * same object one indirection further away.
 *
 * A `sensitive` field gets `autocomplete="new-password"` (input or textarea alike, since
 * `sshPrivateKeyContent` is `sensitive` and `multiline`) -- without it a `type="password"` field like
 * S3's secret key or Git's PAT draws password-manager autofill it has no business attracting.
 *
 * Rows carry no separator element of their own: `WSettingsRow` draws its rule as a `border-top` on
 * `.w-settings-row + .w-settings-row`, an adjacent-SIBLING match, so a field hidden by its `if`
 * condition cannot leave a rule stranded above nothing. The caller supplies the surrounding
 * `WSettingsCard`, and a module with nothing configurable renders nothing at all.
 */

const props = defineProps({
  config: {
    type: Object,
    required: true
  }
})

function inputTypeFor(cfg) {
  if (cfg.multiline) {
    return 'textarea'
  }
  if (cfg.sensitive) {
    return 'password'
  }
  return cfg.type === 'number' ? 'number' : 'text'
}

// A button group has a width of its own and reads wrong stretched; a number is a short value in a
// wide column. Everything else is a field and wants the space.
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
