# Decision: search filter rows are sent as repeated query keys, and only include rows can start a filters-only search

Status: **Adopted** — OpenProject #3518.

## Decision

`frontend/src/pages/Search.vue` sends `searchParams` to `API_CLIENT.get` as an array of
`[name, value]` pairs, one pair per filter row, never as an object holding arrays. A row is
`{ mode, type, value }` (the frozen `searchFilters` preference shape), and
`frontend/src/helpers/searchFilters.js` owns the row-to-name mapping:

| type         | include        | exclude               |
| ------------ | -------------- | --------------------- |
| path         | `path`         | `excludePath`         |
| tag          | `tags`         | `excludeTags`         |
| locale       | `locales`      | `excludeLocales`      |
| editor       | `editor`       | `excludeEditor`       |
| publishState | `publishState` | `excludePublishState` |

Two include rows of one type therefore produce `?publishState=draft&publishState=published`.

A search with no query text and no `#tag` in it runs only when at least one **include** row applies.
Exclude rows alone never start a search.

## Why

- `ky` 2.0.2 turns an object value into `String(value)`, so `{ publishState: ['draft', 'published'] }`
  goes out as `publishState=draft,published`. The backend's `publishState` and `editor` lists are
  validated per item against an enum, so the comma-joined form is rejected with a 400. Only
  `locales`/`tags` accept commas server-side, which would have hidden the problem for two of the five
  types. An array of pairs is the one shape `ky` repeats a key for.
- Excluding narrows a result set; it does not pick one. An empty query with only "exclude
  `private/`" would answer with every readable page, and saved filters load on every visit to
  `/_search`, so that would list the whole wiki whenever a reader with saved exclusions opened the
  page.

## Consequences

- A test asserts a request through `expect.arrayContaining([['name', 'value']])` or
  `new URLSearchParams(searchParams).getAll(name)`, not `objectContaining`.
- Header quick-search and its suggestions do not send saved filters; that stays an open point of #3518.
