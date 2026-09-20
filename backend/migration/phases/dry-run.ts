import crypto from 'node:crypto'

/**
 * Call this *inside* a write model's own method body, never at `entities()`-construction time: a
 * `dryRun: true` run then never touches the ambient `CARDINAL` global at all, and each importer's
 * classification logic still runs identically in both modes.
 */
export async function writeUnlessDryRun<T>(
  dryRun: boolean,
  placeholder: () => T,
  write: () => Promise<T>
): Promise<T> {
  return dryRun ? placeholder() : write()
}

/**
 * An id and nothing else, since `.id` is the only field any importer reads back off a successful
 * write. A caller whose model returns more spreads this and adds the rest.
 */
export function placeholderRow(): { id: string } {
  return { id: crypto.randomUUID() }
}
