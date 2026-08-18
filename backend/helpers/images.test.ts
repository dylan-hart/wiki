import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, mock, test } from 'node:test'
import {
  detectImageMime,
  detectSvg,
  makeImageThumbnail,
  normalizeImage,
  resizeImageToSquareJpeg
} from './images.ts'

/** An 8-byte PNG signature, optionally padded out to a given total length. */
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
})

/**
 * `resizeImageToSquareJpeg`/`normalizeImage`/`makeImageThumbnail` all consult
 * `WIKI.models.extensions` before ever touching Sharp, so this installs a minimal fake of just that
 * surface rather than the full `test/db.ts` fixture — none of the three needs a database.
 */
describe('normalizeImage / resizeImageToSquareJpeg / makeImageThumbnail — Sharp unavailable', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  function installWiki({
    definition = { key: 'sharp', detect: { type: 'module', value: 'sharp' } } as any,
    isInstalled = async () => false
  }: { definition?: any; isInstalled?: () => Promise<boolean> } = {}) {
    const noteLoadFailure = mock.fn()
    const warn = mock.fn()
    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getDefinition: () => definition,
          isInstalled,
          noteLoadFailure
        }
      },
      logger: { warn, debug: mock.fn() }
    }
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
   * The "not installed" tests above stub `WIKI.models.extensions.isInstalled` directly, which is
   * exactly what `moduleExists()` (the real implementation) reports for a package genuinely absent
   * from `node_modules`. This test instead covers the other half of the task description — Sharp
   * *reported* installed (`isInstalled` says yes, matching what a present-but-broken native binary
   * looks like to that check) whose `import()` itself then throws. That can't be forced without an
   * actual failing module resolution, so `node_modules/sharp` is renamed out of the way for the
   * duration of this one test and restored in `finally` even if an assertion throws.
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
      // -> Nothing installed to rename out of the way; import() will fail on its own
      //    (ERR_MODULE_NOT_FOUND), which is the same outcome this test verifies either way.
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
