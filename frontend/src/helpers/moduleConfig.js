/**
 * Turn one module's declared props (a `ModuleProp` map, as `parseModuleProps` in the backend's
 * `helpers/common.ts` normalizes a `definition.yml`) and its currently stored values into the
 * editable shape `ModuleConfigForm.vue` renders and mutates -- one entry per prop, each carrying a
 * mutable `.value`, with `enum` entries expanded from `value|label` strings into `{ value, label }`
 * options a `w-select`/`w-btn-toggle` can bind to directly.
 *
 * Shared by `AdminStorage.vue` (a storage target's `props`) and `AdminSearch.vue` (a search engine's
 * `props`) -- both editing the same `ModuleProp` shape, previously two independent, drifting copies of
 * this same function (task #571/#572). Extracted as part of task #556.
 */
export function buildConfigEditor(props, values) {
  const config = {}
  for (const [key, prop] of Object.entries(props ?? {})) {
    config[key] = {
      ...prop,
      value: values?.[key] ?? prop.default,
      ...(prop.enum && {
        enum: prop.enum.map((entry) => {
          const [value, label] = entry.split('|')
          return { value, label: label ?? value }
        })
      })
    }
  }
  return config
}

/**
 * The plain key/value config a `ModuleConfigForm.vue`-edited object represents, as the API expects
 * it -- read-only props are left out, since the server keeps whatever is stored for them and sending
 * them back would be pretending they can be set.
 *
 * Deliberately just this reduction, not a whole request payload: `AdminStorage.vue`'s target payload
 * wraps this `config` alongside target-only fields (`isEnabled`, `versioning`, ...), while
 * `AdminSearch.vue`'s engine payload is just `{ config }` -- the two callers differ past this point,
 * so only the part that was ever byte-for-byte identical between them is shared here.
 */
export function buildConfigPayload(config) {
  const payload = {}
  for (const [key, cfg] of Object.entries(config ?? {})) {
    if (cfg.readOnly) {
      continue
    }
    payload[key] = cfg.type === 'number' ? Number(cfg.value) : cfg.value
  }
  return payload
}
