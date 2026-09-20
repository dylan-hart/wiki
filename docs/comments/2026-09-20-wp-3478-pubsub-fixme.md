# WP 3478: pubsub FIXME removals

The double `client.release(true)` in `connectListener`'s `'error'` handler is fixed and the fake now
throws on double release, so both FIXME markers describe a defect that no longer exists.

- `backend/helpers/pubsub.ts`, `attach()`: delete the `FIXME: a second release() ...` comment above
  `void reconnect()`.
- `backend/helpers/pubsub.test.ts`, `FakeClient.release`: delete the `FIXME: pg-pool's release()
  throws on a second call ...` comment. Optionally replace it with one line: "Throws on a second
  call, like pg-pool's `_releaseOnce`."
