# WP 3516: AdminFlags Custom Configuration card removal

`frontend/src/pages/AdminFlags.vue`: the "Custom Configuration" `w-settings-card` was deleted whole, so its two HTML comments (the `<!-- No label on the row ... -->` note and the `<!-- TODO: the editor is unbuilt ... -->` marker) went with it as unavoidable collateral of deleting the markup they annotated. No comment was otherwise added, edited or removed.

Nothing further to change: the surviving `<!-- A note about the flags above it, not a setting ... -->` comment still explains a real why and stays.
