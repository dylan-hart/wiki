# WP 3486: recommended comment changes

## `backend/models/pageWatchEvents.ts`

Above `UNREAD_COUNT_SCAN_LIMIT` (add):

```
/**
 * The most unread rows `unreadCount` scans, and so the largest count it can return: each scanned row
 * costs a group-rule evaluation, and an unread backlog is unbounded.
 */
```

`unreadCount` doc comment (replace the whole block, which drops the resolved FIXME):

```
/**
 * Runs the scan through `filterReadable`, like `listForUser`, so the badge never counts a row the
 * inbox drops. Saturates at `UNREAD_COUNT_SCAN_LIMIT`; when the newest rows are unreadable, readable
 * ones beyond the cap go uncounted, which under-counts rather than over-counts.
 */
```

`listForUser` doc comment: replace "and the badge it feeds (`unreadCount`) is a separate, uncapped
query." with "and the badge it feeds (`unreadCount`) is a separate query with its own cap
(`UNREAD_COUNT_SCAN_LIMIT`)."
