import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { detectImageMime, svgMimeType } from '../helpers/images.ts'
import { siteAssetKinds } from './sites.ts'
import type { SiteAssetKind } from './sites.ts'

/**
 * `setAsset`/`getAsset` coordinate an insert-or-update plus `updateSite`'s own
 * read-merge-update-and-reload-cache, so — per CLAUDE.md's DB-backed guidance — this runs the real
 * methods against a migrated database rather than re-describing that SQL with a query-builder mock.
 *
 * What's being verified is the no-Sharp fallback path: `helpers/images.ts#normalizeImage` returns
 * null when the Sharp extension isn't usable, and `Sites.setAsset` falls back to storing the raw
 * uploaded bytes (`?? data`) in that case. `WIKI.models.extensions.isInstalled` is stubbed to force
 * that branch on every call, so the suite is deterministic regardless of whether Sharp happens to be
 * present on the machine actually running it.
 */
describe(
  'sites setAsset/getAsset — no-Sharp fallback (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let sitesModel: typeof import('./sites.ts').sites

    before(async () => {
      fixtures = await setupTestDb()
      ;({ sites: sitesModel } = await import('./sites.ts'))
      mock.method(WIKI.models.extensions, 'isInstalled', async () => false)
    })

    after(async () => {
      mock.restoreAll()
      await teardownTestDb()
    })

    /**
     * An 8-byte PNG signature padded to `size` bytes. Sharp is forced unusable for this whole suite,
     * so `normalizeImage` bails before ever asking it to actually decode these bytes — only the
     * signature needs to be real.
     */
    function pngBuffer(size: number): Buffer {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      return Buffer.concat([signature, Buffer.alloc(size - signature.length, 0xab)])
    }

    const svgBuffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )

    /**
     * A polyglot: a valid PNG signature followed by literal `<svg>...<script>` text later in the
     * buffer. `getAsset` resolves the mime with `detectImageMime(data) ?? (detectSvg(data) ? ... :
     * ...)` — the PNG signature is checked first, so this must come back as `image/png`, never
     * `svgMimeType`. That precedence is what keeps `SVG_CSP` from being skippable by disguising an
     * SVG payload behind a raster magic number: served as `image/png` with `X-Content-Type-Options:
     * nosniff` (`controllers/site.ts`), a browser opening the URL directly trusts the declared type
     * rather than sniffing the trailing markup, so it never gets treated — or executed — as SVG.
     */
    const pngSvgPolyglot = Buffer.concat([
      pngBuffer(64),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    ])

    test('getAsset returns null for a kind that has never been uploaded', async () => {
      const asset = await sitesModel.getAsset(fixtures.siteId, 'logo')
      assert.equal(asset, null)
    })

    test('a PNG-signature/embedded-SVG polyglot round-trips as image/png, not svgMimeType', async () => {
      await sitesModel.setAsset(fixtures.siteId, 'logo', pngSvgPolyglot)
      const asset = await sitesModel.getAsset(fixtures.siteId, 'logo')

      assert.ok(asset)
      assert.equal(asset!.mime, 'image/png')
      assert.notEqual(asset!.mime, svgMimeType)
    })

    for (const kind of siteAssetKinds as readonly SiteAssetKind[]) {
      test(`${kind}: a raw PNG upload up to the 10 MB upload limit is stored and served back byte-for-byte`, async () => {
        // -> One byte under the API route's 10 MB `imageUploadLimit` (`api/sites.ts`) — `setAsset`
        //    itself enforces no size limit of its own, the ceiling is entirely the content-type
        //    parser's `bodyLimit` upstream of it.
        const upload = pngBuffer(10 * 1024 * 1024 - 1)

        await sitesModel.setAsset(fixtures.siteId, kind, upload)
        const asset = await sitesModel.getAsset(fixtures.siteId, kind)

        assert.ok(asset)
        assert.equal(asset!.mime, 'image/png')
        assert.equal(detectImageMime(asset!.data), 'image/png')
        assert.equal(asset!.data.length, upload.length)
        assert.ok(asset!.data.equals(upload), 'stored bytes must match the upload exactly')
      })

      test(`${kind}: an SVG upload is stored and served back byte-for-byte regardless of Sharp`, async () => {
        await sitesModel.setAsset(fixtures.siteId, kind, svgBuffer)
        const asset = await sitesModel.getAsset(fixtures.siteId, kind)

        assert.ok(asset)
        assert.equal(asset!.mime, svgMimeType)
        assert.ok(asset!.data.equals(svgBuffer), 'stored bytes must match the upload exactly')
      })

      test(`${kind}: clearAsset removes the row and flips config.assets.${kind} back off, so getAsset returns null again`, async () => {
        await sitesModel.setAsset(fixtures.siteId, kind, svgBuffer)
        assert.ok(await sitesModel.getAsset(fixtures.siteId, kind), 'sanity: upload landed first')

        const uploadedSite = await sitesModel.getSiteById({
          id: fixtures.siteId,
          forceReload: true
        })
        assert.equal(
          uploadedSite.config.assets?.[kind],
          true,
          'setAsset must flip the cached config flag on'
        )

        await sitesModel.clearAsset(fixtures.siteId, kind)

        const asset = await sitesModel.getAsset(fixtures.siteId, kind)
        assert.equal(asset, null, 'the row must actually be gone, not just unflagged')

        const clearedSite = await sitesModel.getSiteById({ id: fixtures.siteId, forceReload: true })
        assert.equal(
          clearedSite.config.assets?.[kind],
          false,
          'clearAsset must flip the cached config flag back off'
        )
      })
    }
  }
)
