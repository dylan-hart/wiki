import crypto from 'node:crypto'

/**
 * The dry-run/live split every phase's injected write model uses.
 *
 * `ctx.dryRun` is deliberately checked *inside* each write model's own method body rather than at
 * `entities()`-construction time, so a `dryRun: true` run never touches the ambient `WIKI` global at
 * all, and each importer's own classification logic (collision checks, folder resolution, actor
 * fallback, navigation item mapping) still runs identically in both modes — only the
 * destination-touching half is swapped out.
 */
export async function writeUnlessDryRun<T>(
  dryRun: boolean,
  placeholder: () => T,
  write: () => Promise<T>
): Promise<T> {
  return dryRun ? placeholder() : write()
}

/**
 * A dry-run stand-in for a destination row a write model was asked to create: a freshly minted
 * placeholder id and nothing else, since `.id` is the only field any importer reads back off a
 * successful write. Callers whose model returns more than an id spread this and add the rest.
 */
export function placeholderRow(): { id: string } {
  return { id: crypto.randomUUID() }
}
