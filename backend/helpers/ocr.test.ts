import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { commandExists } from '../models/extensions.ts'
import { installFakeCommands, withEmptyPath, type FakeCommands } from '../test/fakeCommands.ts'
import { buildTextPdf } from '../test/pdfFixture.ts'
import { OCR_LIMITS, ocrAvailable, ocrImage, ocrKindOf, ocrPdf } from './ocr.ts'
import { pngHeader, tiffHeader } from '../test/rasterFixtures.ts'

const posix = process.platform !== 'win32'
const execFileAsync = promisify(execFile)

// -> Resolved at module load so each `test(...)` stays a plain declarative registration
const realOcr = posix && (await commandExists('tesseract')) && (await commandExists('pdftoppm'))

/** Just a header: every stand-in tesseract below ignores what it is fed. */
const PNG = pngHeader(640, 480)

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
      const result = await ocrImage(PNG)
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
    const result = await ocrImage(PNG)
    assert.deepEqual(result, { text: 'Invoice 4471', outcome: 'ok', truncated: false })
  })

  test('blank recognition output is empty, not ok', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "\\n \\n"' })
    const result = await ocrImage(PNG)
    assert.equal(result.outcome, 'empty')
    assert.equal(result.text, '')
  })

  test('output past maxChars is cut and flagged', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "abcdefghij"' })
    const result = await ocrImage(PNG, { ...OCR_LIMITS, maxChars: 4 })
    assert.equal(result.text, 'abcd')
    assert.equal(result.truncated, true)
  })

  test('a non-zero exit is failed without throwing', async () => {
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nexit 1' })
    const result = await ocrImage(PNG)
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'exit-error')
  })

  test('a run past the command timeout is killed and reported failed', async () => {
    fake = await installFakeCommands({ tesseract: 'sleep 5' })
    const result = await ocrImage(PNG, { ...OCR_LIMITS, commandTimeoutMs: 100 })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'timeout')
  })

  test('bytes that are not an image are skipped and tesseract is never started', async () => {
    fake = await installFakeCommands({ tesseract: 'touch "$0.ran"\nprintf "leaked"' })
    const marker = path.join(fake.dir, 'tesseract.ran')
    // -> What tesseract reads as a list of files to OCR when it does not recognize an image
    for (const bytes of [
      Buffer.from('/etc/hostname\n/var/lib/wiki/data/cache/files/secret.png\n'),
      // -> The right signature is not enough without a header that goes on to make sense
      Buffer.from('\x89PNG\r\n\x1a\n/etc/hostname\n', 'latin1'),
      Buffer.from('II*\u0000/etc/hostname\n', 'latin1')
    ]) {
      const result = await ocrImage(bytes)
      assert.deepEqual(result, {
        text: '',
        outcome: 'skipped',
        reason: 'not-an-image',
        truncated: false
      })
    }
    assert.equal(existsSync(marker), false)
  })

  test('an image whose header claims more than maxPixels is skipped unread', async () => {
    fake = await installFakeCommands({ tesseract: 'touch "$0.ran"' })
    const result = await ocrImage(pngHeader(25_000, 25_000))
    assert.equal(result.outcome, 'skipped')
    assert.equal(result.reason, 'too-many-pixels')
    assert.equal(existsSync(path.join(fake.dir, 'tesseract.ran')), false)
    assert.equal((await ocrImage(pngHeader(5000, 5000))).outcome, 'empty')
  })

  test('a TIFF with more pages than maxPages is skipped unread', async () => {
    fake = await installFakeCommands({ tesseract: 'touch "$0.ran"' })
    const pages = Array.from({ length: OCR_LIMITS.maxPages + 1 }, () => [100, 100] as const)
    const result = await ocrImage(tiffHeader(pages))
    assert.equal(result.reason, 'too-many-pages')
    assert.equal(existsSync(path.join(fake.dir, 'tesseract.ran')), false)
  })

  test('ocrPdf asks pdftoppm for a fixed long side, not a resolution', async () => {
    fake = await installFakeCommands({ pdftoppm: 'printf "%s\\n" "$@" > "$0.args"' })
    await ocrPdf(Buffer.from('%PDF-1.4'))
    const args = (await readFile(path.join(fake.dir, 'pdftoppm.args'), 'utf8')).split('\n')
    assert.equal(args[args.indexOf('-scale-to') + 1], String(OCR_LIMITS.pdfRenderSize))
    assert.equal(args.includes('-r'), false)
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

describe('OCR with the real binaries', { skip: !realOcr }, () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  async function renderPng(text: string): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-ocr-real-'))
    await writeFile(path.join(dir, 'in.pdf'), buildTextPdf([text]))
    await execFileAsync('pdftoppm', [
      '-r',
      '150',
      '-png',
      '-singlefile',
      path.join(dir, 'in.pdf'),
      path.join(dir, 'page')
    ])
    return path.join(dir, 'page.png')
  }

  test('recognizes the text of a real image', async () => {
    const result = await ocrImage(await readFile(await renderPng('Invoice 4471')))
    assert.equal(result.outcome, 'ok')
    assert.match(result.text, /Invoice 4471/)
  })

  test('never reads the files a path list names', async () => {
    const image = await renderPng('Payroll 9313')
    const result = await ocrImage(Buffer.from(`${image}\n`))
    assert.equal(result.outcome, 'skipped')
    assert.doesNotMatch(result.text, /9313/)
  })

  test('a PDF page with a vast MediaBox renders small enough to finish quickly', async () => {
    const result = await ocrPdf(buildTextPdf(['Poster'], { mediaBox: [12_000, 12_000] }), {
      ...OCR_LIMITS,
      commandTimeoutMs: 5000
    })
    assert.notEqual(result.outcome, 'failed')
  })

  test('recognizes the text of a real PDF page', async () => {
    const result = await ocrPdf(buildTextPdf(['Quarterly ledger']))
    assert.equal(result.outcome, 'ok')
    assert.match(result.text, /Quarterly ledger/)
  })
})
