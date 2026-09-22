/**
 * The async other half of `htmlToMarkdown`, which is synchronous and so hands back
 * `![alt](pending-image:N)` placeholders rather than fetching an embedded image's bytes itself.
 * `fetch` turns all three `src` shapes -- `data:`, `blob:` and `http(s):` -- into bytes uniformly. A
 * `src` that cannot be retrieved (cross-origin CORS, a `blob:` from a navigated-away tab) drops just
 * that one image.
 */
export async function resolvePendingImages(
  markdown,
  images,
  { refuse = false, keepReferences = false, addPendingAsset } = {}
) {
  let content = markdown
  await Promise.all(
    images.map(async ({ token, src, alt }) => {
      const placeholder = `![${alt}](${token})`
      if (refuse) {
        content = content.split(placeholder).join('')
        return
      }
      if (keepReferences) {
        content = content.split(placeholder).join(`![${alt}](${src})`)
        return
      }
      let replacement = ''
      try {
        const response = await fetch(src)
        if (!response.ok) {
          throw new Error(`Failed to fetch pasted image: ${response.status}`)
        }
        const blob = await response.blob()
        const blobUrl = addPendingAsset(blob)
        replacement = `![${alt}](${blobUrl})`
      } catch {
        replacement = ''
      }
      // -> `token` is unique per call (see `htmlToMarkdown`), so this can only match the placeholder
      //    it was generated for
      content = content.split(placeholder).join(replacement)
    })
  )
  return content
}

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm
const INLINE_CODE = /(`+)[^`]*?\1/g
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]+))/g
const HTML_IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi

function isResolvable(reference) {
  return /^(?:https?:|data:)/i.test(reference) || reference.startsWith('/')
}

export function findUnresolvedImageReferences(markdown) {
  const prose = markdown.replace(FENCED_CODE, '').replace(INLINE_CODE, '')
  const found = []
  for (const match of prose.matchAll(MARKDOWN_IMAGE)) {
    found.push({ index: match.index, reference: match[1] ?? match[2] })
  }
  for (const match of prose.matchAll(HTML_IMG_SRC)) {
    found.push({ index: match.index, reference: match[1] ?? match[2] ?? match[3] })
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ reference }) => reference)
    .filter((reference) => reference && !isResolvable(reference))
}
