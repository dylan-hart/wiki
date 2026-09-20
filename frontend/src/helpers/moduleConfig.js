/**
 * `props` is a `ModuleProp` map, as the backend's `parseModuleProps` normalizes a `definition.yml`
 * into. Each entry gets a mutable `.value` for `ModuleConfigForm.vue` to bind to, and an `enum`'s
 * `value|label` strings are expanded into `{ value, label }` options a `w-select`/`w-btn-toggle` can
 * bind to directly.
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
 * Read-only props are left out: the server keeps whatever is stored for them, and sending them back
 * would be pretending they can be set.
 *
 * Deliberately just this reduction and not a whole request payload -- each caller wraps the result in
 * fields of its own, so only the part identical between them is shared here.
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
