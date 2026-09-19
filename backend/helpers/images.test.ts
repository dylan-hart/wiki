import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, mock, test } from 'node:test'
import {
  detectImageMime,
  detectSvg,
  makeImageThumbnail,
  normalizeImage,
  resizeImageToSquareJpeg,
  sanitizeSvg
} from './images.ts'

import { installTestWiki } from '../test/mocks.ts'

function pngBytes(length = 16): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, Buffer.alloc(Math.max(0, length - signature.length))])
}

describe('detectImageMime', () => {
  test('recognizes a PNG by its 8-byte signature', () => {
    assert.equal(detectImageMime(pngBytes()), 'image/png')
  })

  test('recognizes a JPEG by its SOI marker', () => {
    const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)])
    assert.equal(detectImageMime(data), 'image/jpeg')
  })

  test('recognizes GIF87a', () => {
    const data = Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(6)])
    assert.equal(detectImageMime(data), 'image/gif')
  })

  test('recognizes GIF89a', () => {
    const data = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(6)])
    assert.equal(detectImageMime(data), 'image/gif')
  })

  test('recognizes a WebP RIFF container', () => {
    const data = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'latin1')
    ])
    assert.equal(detectImageMime(data), 'image/webp')
  })

  test('does not mistake a non-WEBP RIFF container (e.g. AVI) for a WebP', () => {
    const data = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('AVI ', 'latin1')
    ])
    assert.equal(detectImageMime(data), null)
  })

  test('returns null for a buffer too short to hold any signature', () => {
    assert.equal(detectImageMime(Buffer.alloc(5)), null)
  })

  test('returns null for bytes that are not one of the supported formats', () => {
    assert.equal(detectImageMime(Buffer.from('this is plain text, not an image at all')), null)
  })
})

describe('detectSvg', () => {
  test('recognizes plain SVG markup', () => {
    assert.equal(detectSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), true)
  })

  test('recognizes SVG preceded by an XML declaration and a doctype', () => {
    const markup =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'
    assert.equal(detectSvg(Buffer.from(markup)), true)
  })

  test('recognizes SVG preceded by a UTF-8 byte order mark', () => {
    const markup = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    ])
    assert.equal(detectSvg(markup), true)
  })

  test('recognizes SVG preceded by a leading comment', () => {
    const markup = '<!-- exported from a design tool -->\n<svg><rect/></svg>'
    assert.equal(detectSvg(Buffer.from(markup)), true)
  })

  test('returns false for a PNG', () => {
    assert.equal(detectSvg(pngBytes()), false)
  })

  test('returns false for plain markup with no svg element', () => {
    assert.equal(detectSvg(Buffer.from('<html><body>not an svg</body></html>')), false)
  })

  test('returns false for a truncated/malformed fragment that merely starts with the letters "svg"', () => {
    assert.equal(detectSvg(Buffer.from('<svgness-is-not-a-tag>')), false)
  })

  test('returns false for a corrupted/incomplete SVG whose root element never appears within the first 1024 bytes', () => {
    const padding = 'x'.repeat(1100)
    const markup = `<?xml version="1.0"?>\n<!-- ${padding} -->\n<svg></svg>`
    assert.equal(detectSvg(Buffer.from(markup)), false)
  })

  test('is case-insensitive, matching an upper-cased root element', () => {
    assert.equal(detectSvg(Buffer.from('<SVG xmlns="http://www.w3.org/2000/svg"></SVG>')), true)
  })

  test(
    'polyglot: bytes carrying a valid PNG signature that also embed literal "<svg" text later in ' +
      'the buffer are still recognized as SVG-shaped by detectSvg in isolation — precedence between ' +
      "the two detectors is `Sites.getAsset`/`setAsset`'s job (detectImageMime is consulted first " +
      "there), not this function's",
    () => {
      const polyglot = Buffer.concat([
        pngBytes(64),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      ])
      assert.equal(detectImageMime(polyglot), 'image/png')
      assert.equal(detectSvg(polyglot), true)
    }
  )
})

describe('sanitizeSvg', () => {
  test('strips a script tag and its contents', () => {
    const out = sanitizeSvg(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    ).toString('utf8')
    assert.ok(!out.includes('<script'))
    assert.ok(!out.includes('alert(1)'))
  })

  test('strips an event-handler attribute off an otherwise-allowed element', () => {
    const out = sanitizeSvg(
      Buffer.from('<svg><circle cx="1" cy="1" r="1" onload="alert(1)"/></svg>')
    ).toString('utf8')
    assert.ok(!out.includes('onload'))
    assert.ok(!out.includes('alert'))
  })

  test('strips foreignObject and everything nested inside it', () => {
    const out = sanitizeSvg(
      Buffer.from('<svg><foreignObject><body onload="alert(1)">hi</body></foreignObject></svg>')
    ).toString('utf8')
    assert.ok(!out.includes('foreignObject'))
    assert.ok(!out.includes('onload'))
  })

  test('strips a SMIL animation element', () => {
    const out = sanitizeSvg(
      Buffer.from('<svg><rect><animate attributeName="x" to="alert(1)"/></rect></svg>')
    ).toString('utf8')
    assert.ok(!out.includes('<animate'))
  })

  test('strips a javascript: scheme off an href', () => {
    const out = sanitizeSvg(Buffer.from('<svg><use href="javascript:alert(1)"/></svg>')).toString(
      'utf8'
    )
    assert.ok(!out.includes('javascript:'))
  })

  test('keeps structural elements and their presentation attributes, case-sensitive', () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<circle cx="5" cy="5" r="4" fill="red"/>' +
      '</svg>'
    const out = sanitizeSvg(Buffer.from(markup)).toString('utf8')
    assert.ok(out.includes('viewBox="0 0 10 10"'))
    assert.ok(out.includes('<circle'))
    assert.ok(out.includes('fill="red"'))
  })

  test('keeps a fragment reference on use/href untouched', () => {
    const markup = '<svg><defs><circle id="c" cx="1" cy="1" r="1"/></defs><use href="#c"/></svg>'
    const out = sanitizeSvg(Buffer.from(markup)).toString('utf8')
    assert.ok(out.includes('href="#c"'))
  })
})

/**
 * All three consult `CARDINAL.models.extensions` before touching Sharp, so a minimal fake of that
 * surface is enough — none of them needs a database.
 */
describe('normalizeImage / resizeImageToSquareJpeg / makeImageThumbnail — Sharp unavailable', () => {
  let wikiHandle: { restore(): void }

  after(() => {
    wikiHandle.restore()
  })

  function installWiki({
    definition = { key: 'sharp', detect: { type: 'module', value: 'sharp' } } as any,
    isInstalled = async () => false
  }: { definition?: any; isInstalled?: () => Promise<boolean> } = {}) {
    const noteLoadFailure = mock.fn()
    const warn = mock.fn()
    wikiHandle = installTestWiki({
      models: {
        extensions: {
          getDefinition: () => definition,
          isInstalled,
          noteLoadFailure
        }
      },
      logger: { warn, debug: mock.fn() }
    })
    return { noteLoadFailure, warn }
  }

  test('resizeImageToSquareJpeg returns null when the extension has no definition at all', async () => {
    installWiki({ definition: null })
    const result = await resizeImageToSquareJpeg(Buffer.from('irrelevant'), 64)
    assert.equal(result, null)
  })

  test('normalizeImage returns null when the extension is not installed', async () => {
    installWiki({ isInstalled: async () => false })
    const result = await normalizeImage(Buffer.from('irrelevant'), {
      width: 64,
      height: 64,
      fit: 'cover',
      format: 'webp'
    })
    assert.equal(result, null)
  })

  test('makeImageThumbnail returns null when the extension is not installed', async () => {
    installWiki({ isInstalled: async () => false })
    const result = await makeImageThumbnail(Buffer.from('irrelevant'), 64, 64)
    assert.equal(result, null)
  })

  /**
   * The present-but-broken case: `isInstalled` says yes, but `import()` throws — which is what a
   * native binary built for another platform looks like. It cannot be forced without a genuinely
   * failing module resolution, so `node_modules/sharp` is renamed aside for this one test and
   * restored in `finally`.
   */
  test('normalizeImage returns null and records a load failure when Sharp is reported installed but cannot actually be imported', async () => {
    const nodeModulesDir = path.join(import.meta.dirname, '..', 'node_modules')
    const sharpDir = path.join(nodeModulesDir, 'sharp')
    const disabledDir = path.join(nodeModulesDir, '.sharp-disabled-for-test')

    let wasRenamed = false
    try {
      await fs.rename(sharpDir, disabledDir)
      wasRenamed = true
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err
      }
      // -> Nothing to rename aside; `import()` fails on its own, the same outcome either way
    }

    try {
      const { noteLoadFailure, warn } = installWiki({ isInstalled: async () => true })

      const result = await normalizeImage(Buffer.from('irrelevant'), {
        width: 64,
        height: 64,
        fit: 'cover',
        format: 'webp'
      })

      assert.equal(result, null)
      assert.equal(noteLoadFailure.mock.calls.length, 1)
      assert.equal(noteLoadFailure.mock.calls[0].arguments[0], 'sharp')
      assert.equal(warn.mock.calls.length, 1)
    } finally {
      if (wasRenamed) {
        await fs.rename(disabledDir, sharpDir)
      }
    }
  })
})
