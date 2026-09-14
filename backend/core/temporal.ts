/**
 * Installs the real `Temporal` global at boot, for every backend entry point (`index.ts`, `worker.ts`).
 *
 * `Temporal` is native on every **official** Node 26 build this project targets (`node:26.8.1-slim`,
 * `node:26.7.0-bookworm` -- production's own image, and setup-node's official binaries in CI --
 * verified directly: `typeof Temporal` is `object` and `Date.prototype.toTemporalInstant` exists on
 * each). It is absent only on a build V8 was compiled without Temporal support for
 * (`v8_enable_temporal_support=0`) -- this repo's own prior claim that Node 26.7.0 lacked it natively
 * came from exactly that: a Homebrew Node 26.8.1 on macOS, not Node 26 itself.
 *
 * Feature-detected, so this is a no-op on every official build (CI, the devcontainer, production) and
 * only actually installs anything on a Temporal-less build like Homebrew's. `temporal-polyfill/global`
 * is the same polyfill package `frontend/` and `blocks/` already use for pre-Temporal Safari -- one
 * polyfill across every workspace -- and its `/global` entry point installs `globalThis.Temporal`,
 * `Date.prototype.toTemporalInstant` and the `Intl.DateTimeFormat` Temporal overloads itself as an
 * import side effect, so there is nothing further to wire up here.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    await import('temporal-polyfill/global')
  }
}
