# WP #3525 — recommended comment changes

Comments are not edited in the patch; these are the recommendations.

## `backend/mcp/http.test.ts` (block above `describe('mcp/http session eviction (OpenProject #2207)'`)

The JSDoc says the "ACTIVE session is never evicted" claim lives in `mcp/http.flaky.test.ts`. That
file is deleted and the claim now lives in the `active-session liveness` suite below it. Delete the
whole block; the suite titles carry what is left.

Also in that suite, `// -> Well past the 30ms idle ttl ...` still describes a real sleep, which is
correct and stays. The two eviction tests there could move to the injected clock as a follow-up, at
which point that comment goes too.

## `backend/test/mcpSessionHarness.ts` (file-level JSDoc)

"shared by its eviction suites across two test lanes" is no longer true. Recommended:

```ts
/**
 * The session-lifecycle half of `mcp/http.ts`'s coverage.
 */
```

## `backend/mcp/http.ts`

The `HttpRoutesOptions` JSDoc reads "Test-only overrides of the two defaults above." With `clock` it
is three test-only options and `clock` overrides no default. Recommended:

```ts
/** Test-only overrides. `clock` replaces the cache's time source so a test can advance idle time without sleeping. */
```

Add one why-comment at the `perf`/`ttlResolution` spread in the `LRUCache` options:

```ts
// -> ttlResolution 0: lru-cache otherwise caches `perf.now()` for ttlResolution real ms, which
//    would read stale against an injected clock.
```

## `backend/test/mcpSessionHarness.ts` / fake-clock callers

A fake clock must start above 0: lru-cache treats a recorded start of 0 as "no ttl".

## Marker removal

The `QUARANTINED ... TODO` block in `backend/mcp/http.flaky.test.ts` went with the file; nothing else
references it.
