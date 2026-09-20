# WP #3555 — `frontend/src/components/ProfileOverlay.vue`

Not applied (comments are recommendations only).

- Template, above the "Preview public profile" item: the comment "A real navigation away from the
  overlay, so it closes rather than floating over whatever page it lands the reader on." is now
  false — the item no longer navigates. Replace with (or delete):
  `<!-- -> Closes the overlay before opening the popover: the dialog traps focus and would sit over it. -->`
