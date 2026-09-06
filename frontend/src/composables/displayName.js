import { ref, watch } from 'vue'

/**
 * How a display name is composed from the two authored halves (Feature #2608).
 *
 * The client-side twin of `backend/models/users.ts#deriveDisplayName`, and it must stay identical to
 * it: the server compares a submitted `name` against its own derivation to decide whether the name
 * has been hand-authored, so a form that derived even slightly differently would author accounts
 * nobody meant to author. A mononym -- an empty last name -- derives to the first name alone.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @returns {string} The derived display name.
 */
export function deriveDisplayName(firstName, lastName) {
  return `${firstName ?? ''} ${lastName ?? ''}`.trim()
}

/**
 * Keep a form's display-name field tracking its two halves, until somebody overrides it.
 *
 * ## Why a form needs this at all
 *
 * The server owns the rule (`models/users.ts#updateUser`): a submitted `name` equal to what the
 * halves derive to means "keep deriving", anything else authors the name for good. A form that
 * submits all three fields therefore only stays honest if its display-name field is *current* -- edit
 * the first name alone and leave a stale `name` behind, and the save reads as a deliberate override
 * and freezes the display name at the old value. That is a silent, permanent change to an account
 * nobody asked for, and it is what this exists to prevent.
 *
 * So: while the name is derived, editing either half rewrites it live, and the reader sees what the
 * account is about to be called. Type something else into it and it stops tracking -- which is the
 * override the parent Feature grants. Type the derived value back in and it resumes, matching the
 * server's own "put this back on derivation" behaviour rather than inventing a second rule.
 *
 * The initial "is this authored" answer is a value comparison at load. That is deliberately NOT the
 * same thing as the re-login inference Feature #2608's scope rules out: this decides only whether a
 * form field keeps auto-filling while it is open, and the server still consults its own stored marker
 * and decides for itself on write. Nothing here is authoritative.
 *
 * @param {() => object} getFields Returns the reactive object carrying `name`, `firstName` and
 *   `lastName` -- typically a form's own `state.config` / `state.user`, so the template goes on
 *   reading it unchanged. A getter rather than the object itself because a form that loads a record
 *   by REPLACING its container (`state.user = user`) would otherwise leave these watchers bound to
 *   the object it threw away.
 * @returns {{ authored: import('vue').Ref<boolean>, syncFromStored: () => void }} `authored` reports
 *   whether the name has been overridden; `syncFromStored()` re-reads that answer off the fields as
 *   they now stand, and is what a form calls after loading (or reloading) a record into them.
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
