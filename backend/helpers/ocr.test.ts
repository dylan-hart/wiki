import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { installFakeCommands, withEmptyPath, type FakeCommands } from '../test/fakeCommands.ts'
import { OCR_LIMITS, ocrAvailable, ocrImage, ocrKindOf, ocrPdf } from './ocr.ts'

const posix = process.platform !== 'win32'

describe('ocrKindOf', () => {
  test('recognises raster images by mime type or extension, and PDFs', () => {
    assert.equal(ocrKindOf('png', 'image/png'), 'image')
    assert.equal(ocrKindOf('jpeg', ''), 'image')
    assert.equal(ocrKindOf('', 'image/tiff'), 'image')
    assert.equal(ocrKindOf('pdf', 'application/octet-stream'), 'pdf')
    assert.equal(ocrKindOf('bin', 'application/pdf'), 'pdf')
  })

  test('has no opinion on svg, text or unknown files', () => {
    assert.equal(ocrKindOf('svg', 'image/svg+xml'), null)
    assert.equal(ocrKindOf('txt', 'text/plain'), null)
    assert.equal(ocrKindOf('zip', 'application/zip'), null)
  })
})

describe('OCR without the binaries', () => {
  test('ocrAvailable is false for both kinds when nothing is on PATH', async () => {
    await withEmptyPath(async () => {
      assert.equal(await ocrAvailable('image'), false)
      assert.equal(await ocrAvailable('pdf'), false)
    })
  })

  test('ocrImage reports skipped rather than failed', async () => {
    await withEmptyPath(async () => {
      const result = await ocrImage(Buffer.from('not really an image'))
      assert.equal(result.outcome, 'skipped')
      assert.equal(result.reason, 'not-installed')
      assert.equal(result.text, '')
    })
  })

  test('ocrPdf reports skipped rather than failed', async () => {
    await withEmptyPath(async () => {
      const result = await ocrPdf(Buffer.from('%PDF-1.4'))
      assert.equal(result.outcome, 'skipped')
      assert.equal(result.reason, 'not-installed')
    })
  })

  test('an oversized input is skipped before anything is spawned', async () => {
    const result = await ocrImage(Buffer.alloc(11), { ...OCR_LIMITS, maxBytes: 10 })
    assert.equal(result.outcome, 'skipped')
    assert.equal(result.reason, 'too-large')
    assert.equal(
      (await ocrPdf(Buffer.alloc(11), { ...OCR_LIMITS, maxBytes: 10 })).outcome,
      'skipped'
    )
  })
})

describe('OCR with stand-in binaries', { skip: !posix }, () => {
  let fake: FakeCommands | undefined

  afterEach(async () => {
    await fake?.restore()
    fake = undefined
  })

  test('ocrAvailable needs pdftoppm as well for a PDF', async () => {
    fake = await installFakeCommands({ tesseract: 'exit 0' })
    assert.equal(await ocrAvailable('image'), true)
    await fake.restore()
    fake = await installFakeCommands({ tesseract: 'exit 0', pdftoppm: 'exit 0' })
    assert.equal(await ocrAvailable('pdf'), true)
  })

  test('ocrImage feeds the bytes on stdin and returns trimmed stdout', async () => {
    fake = await installFakeCommands({
      tesseract:
        '[ "$1" = stdin ] && [ "$2" = stdout ] || exit 9\ncat >/dev/null\nprintf "  Invoice 4471\\n"'
    })
    const result = await ocrImage(Buffer.from('bytes'))
    assert.deepEqual(result, { text: 'Invoice 4471', outcome: 'ok', truncated: false })
  })

  test('blank recognition output is empty, not ok', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "\\n \\n"' })
    const result = await ocrImage(Buffer.from('bytes'))
    assert.equal(result.outcome, 'empty')
    assert.equal(result.text, '')
  })

  test('output past maxChars is cut and flagged', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "abcdefghij"' })
    const result = await ocrImage(Buffer.from('bytes'), { ...OCR_LIMITS, maxChars: 4 })
    assert.equal(result.text, 'abcd')
    assert.equal(result.truncated, true)
  })

  test('a non-zero exit is failed without throwing', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nexit 1' })
    const result = await ocrImage(Buffer.from('bytes'))
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'exit-error')
  })

  test('a run past the command timeout is killed and reported failed', async () => {
    fake = await installFakeCommands({ tesseract: 'sleep 5' })
    const result = await ocrImage(Buffer.from('bytes'), { ...OCR_LIMITS, commandTimeoutMs: 100 })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'timeout')
  })

  test('ocrPdf rasterises with pdftoppm and joins the pages in order', async () => {
    fake = await installFakeCommands({
      pdftoppm: 'for arg; do root="$arg"; done\nprintf x > "$root-1.png"\nprintf x > "$root-2.png"',
      tesseract:
        'case "$1" in *page-1.png) printf "first page";; *page-2.png) printf "second page";; esac'
    })
    const result = await ocrPdf(Buffer.from('%PDF-1.4'))
    assert.deepEqual(result, { text: 'first page\nsecond page', outcome: 'ok', truncated: false })
  })

  test('ocrPdf keeps the pages it finished when the overall budget runs out', async () => {
    fake = await installFakeCommands({
      pdftoppm: 'for arg; do root="$arg"; done\nprintf x > "$root-1.png"\nprintf x > "$root-2.png"',
      tesseract: 'case "$1" in *page-1.png) printf "page";; *) sleep 5;; esac'
    })
    const result = await ocrPdf(Buffer.from('%PDF-1.4'), { ...OCR_LIMITS, totalTimeoutMs: 1000 })
    assert.deepEqual(result, { text: 'page', outcome: 'ok', truncated: true })
  })

  test('ocrPdf is failed when the first page already exceeds the budget', async () => {
    fake = await installFakeCommands({
      pdftoppm: 'for arg; do root="$arg"; done\nprintf x > "$root-1.png"',
      tesseract: 'sleep 5'
    })
    const result = await ocrPdf(Buffer.from('%PDF-1.4'), { ...OCR_LIMITS, totalTimeoutMs: 1500 })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'timeout')
  })

  test('a pdftoppm failure (encrypted or corrupt PDF) is failed, not thrown', async () => {
    fake = await installFakeCommands({ pdftoppm: 'exit 1', tesseract: 'exit 0' })
    const result = await ocrPdf(Buffer.from('%PDF-1.4'))
    assert.equal(result.outcome, 'failed')
  })

  test('a PDF that renders no pages is empty', async () => {
    fake = await installFakeCommands({ pdftoppm: 'exit 0', tesseract: 'exit 0' })
    const result = await ocrPdf(Buffer.from('%PDF-1.4'))
    assert.equal(result.outcome, 'empty')
  })
})
