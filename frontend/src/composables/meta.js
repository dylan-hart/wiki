import { onScopeDispose, watchEffect } from 'vue'

/**
 * Document title only: a `title` registered by pages and a `titleTemplate` registered by layouts
 * that wraps it. Registrations form a stack in mount order, and the most recent of each wins -- so
 * a layout mounting first and a page mounting second combine the way the component tree implies,
 * with no provide/inject to model.
 */

/** @type {Array<{ title?: string, titleTemplate?: (t: string) => string }>} */
const stack = []

function apply() {
  let title
  let template
  for (const entry of stack) {
    if (entry.title !== undefined) {
      title = entry.title
    }
    if (entry.titleTemplate !== undefined) {
      template = entry.titleTemplate
    }
  }
  if (title === undefined) {
    return
  }
  document.title = template ? template(title) : title
}

/**
 * @param {object|(() => object)} source Either a plain `{ title }` / `{ titleTemplate }` object, or
 *   a getter returning one -- pass a getter when the title depends on reactive state, since a plain
 *   object is read once at call time.
 */
export function useMeta(source) {
  const entry = {}
  stack.push(entry)

  if (typeof source === 'function') {
    watchEffect(() => {
      Object.assign(entry, source())
      apply()
    })
  } else {
    Object.assign(entry, source)
    apply()
  }

  onScopeDispose(() => {
    const idx = stack.indexOf(entry)
    if (idx >= 0) {
      stack.splice(idx, 1)
    }
    apply()
  })
}
