import { ref, watch } from 'vue'

/**
 * Must stay character-for-character identical to `backend/models/users.ts#deriveDisplayName`: the
 * server compares a submitted `name` against its own derivation to decide whether the name has been
 * hand-authored, so a form deriving even slightly differently would author accounts nobody meant to
 * author.
 */
export function deriveDisplayName(firstName, lastName) {
  return `${firstName ?? ''} ${lastName ?? ''}`.trim()
}

/**
 * The server (`models/users.ts#updateUser`) reads a submitted `name` equal to the halves' derivation
 * as "keep deriving" and anything else as an override that sticks, so a form submitting all three
 * fields only stays honest if its display-name field is current: edit a half, leave a stale `name`
 * behind, and the save silently freezes the display name at the old value. Typing the derived value
 * back in resumes derivation, matching the server rather than inventing a second rule. Nothing here
 * is authoritative -- the server consults its own stored marker on write.
 *
 * A form calls `syncFromStored()` after loading (or reloading) a record into the fields.
 *
 * @param {() => object} getFields Returns the reactive object carrying `name`, `firstName` and
 *   `lastName`. A getter rather than the object itself because a form that loads a record by
 *   REPLACING its container (`state.user = user`) would otherwise leave these watchers bound to the
 *   object it threw away.
 */
export function useDerivedDisplayName(getFields) {
  const authored = ref(false)

  function syncFromStored() {
    const fields = getFields()
    if (!fields) {
      return
    }
    authored.value = (fields.name ?? '') !== deriveDisplayName(fields.firstName, fields.lastName)
  }

  watch(
    () => {
      const fields = getFields()
      return [fields?.firstName, fields?.lastName]
    },
    () => {
      const fields = getFields()
      if (fields && !authored.value) {
        fields.name = deriveDisplayName(fields.firstName, fields.lastName)
      }
    }
  )

  // -> Watching the name as well is what lets an override be undone. The half-watcher above writes a
  //    value that IS the derivation, so its own write leaves `authored` false rather than latching it.
  watch(
    () => getFields()?.name,
    () => {
      syncFromStored()
    }
  )

  return { authored, syncFromStored }
}
