# Comment recommendations: OpenProject #3622 (backend/models/assetServing.ts)

- `AssetServing` class doc: "the database is the one durable copy of an asset's bytes" is no longer always true. Once bytes are offloaded a nominated read-through target can hold the only copy, so say serving goes disk cache, then read-through targets, then the DB, and that the DB is tried last.
- `governingTarget`'s doc: "An asset's bytes always live in the assets table regardless of what else is configured" is stale for the same reason. The db target's `assetDelivery` settings still decide caching and redirecting; only the "bytes always in the table" clause needs to go.
- `directUrlFor`'s doc: "The bytes always live in the assets table, so a signing failure is never fatal" should read that a signing failure falls back to streaming, from a read-through target or the DB.
- `readContent`'s doc: "off means every request is a buffered read straight from the database" becomes "a buffered read from the DB, or a stream from a read-through target, never touching this instance's disk".
- `writeContentCache`'s doc: "the database answers every request the cache cannot" is stale, since a read-through target can answer too.
- `readSourcesFrom` (new): the order of the list it is given is the order sources are tried, and `#3624`'s offload verification is meant to reuse it, so keep the filter in this one place.
- `teeChunks` (new): the temp file name carries a random suffix because concurrent requests for the same asset are common. The rename happens inside the generator's `finally`, before the last chunk reaches the client, so a request right behind it hits the cache.
- Operational note for whichever hint text lands with #3615: changing a target's `pathPrefix` after bytes were offloaded orphans the bucket copies. `readAsset` then returns null, the DB row is null, and the asset answers 404.
