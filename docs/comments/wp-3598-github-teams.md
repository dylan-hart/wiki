# WP 3598: github/authentication.ts comment recommendations

- `authorizationUrl`, the block comment above the `scope` setting: it says `read:org` is asked for only when an organization is being enforced. It is now also asked for when `mapGroups` is on (team lookup). Suggested: "`read:org` is asked for only when an organization is enforced or teams are mapped to groups, since a scope nobody needs is a scope nobody should be granting."
- `MAX_TEAM_PAGES` (no comment added, per repo rule). If wanted: "Bounds the Link walk so a misbehaving host cannot loop the login forever."
- `teams()` (no comment added). If wanted: "Throws rather than answering [] on any failure: an empty list would strip the user's mapped groups. A next link off the API host is refused so the bearer token is never sent elsewhere."
