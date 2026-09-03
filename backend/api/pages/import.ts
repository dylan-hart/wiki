import type { FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import {
  detectImportFormat,
  MAX_IMPORT_BATCH_BYTES,
  MAX_IMPORT_BATCH_FILES,
  MAX_IMPORT_SIZE,
  SUPPORTED_IMPORT_FORMATS
} from '../../models/import.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { actorFrom, mayOnPage } from '../../helpers/pageAccess.ts'

/**
 * The two file-upload routes that convert a document to Markdown, and -- because `register()` is a
 * real encapsulation boundary -- the body parsers they need, which no other page route now sees.
 */
async function routes(app: FastifyInstance) {
  // -> IMPORT PAGE's body is the uploaded file's raw bytes, not a multipart form or JSON — the same
  //    approach `api/assets.ts` uses for asset uploads. The catch-all only claims content types
  //    nothing else in this file parses; registered here rather than on the whole `pages` resource,
  //    so the sibling sub-plugins' JSON routes never see it at all (API-F5).
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: MAX_IMPORT_SIZE },
    (req, body, done) => {
      done(null, body)
    }
  )

  // -> IMPORT PAGES (BATCH)'s body carries several files in one request, which the raw-bytes approach
  //    above has no room for — `@fastify/multipart` claims `multipart/form-data` specifically, which
  //    Fastify matches ahead of the generic `'*'` parser above regardless of registration order.
  //    `throwFileSizeLimit: false` (OpenProject #849 fix): the default `true` makes an oversized
  //    file's `toBuffer()` reject as documented below, but the plugin ALSO latches that rejection as
  //    `lastError` and replays it out of `req.files()`'s own iterator on the very next `for await`
  //    step — even one that only advances past files already handled — which turned "one bad file
  //    fails independently" into "one oversized file 413s the whole batch, however many files came
  //    after it converted fine". Disabled, a stream still stops accepting bytes past the limit and
  //    `file.file.truncated` still flips true; the route below reads that flag itself instead of
  //    trusting `toBuffer()` to throw.
  //    `fields: MAX_IMPORT_BATCH_FILES` (OpenProject #1209): one optional `formats` text field per
  //    `files` entry, interleaved file-then-its-format by the frontend, lets a caller override a
  //    single file's autodetected format without giving every field in the batch one.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_IMPORT_SIZE,
      files: MAX_IMPORT_BATCH_FILES,
      fields: MAX_IMPORT_BATCH_FILES
    },
    throwFileSizeLimit: false
  })

  /**
   * IMPORT PAGE CONTENT
   */
  app.post<{
    Params: { siteId: string }
    Querystring: { fileName: string; format?: string; path: string; locale?: string }
  }>(
    '/sites/:siteId/pages/import',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES, addressed by the path the converted content would be saved to.
        Checked against that path below, exactly like CREATE PAGE in `api/pages/write.ts`.
      */
      schema: {
        summary: 'Convert an uploaded file to Markdown',
        description: `The body is the file itself, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round(MAX_IMPORT_SIZE / 1024 / 1024)} MB. \`fileName\`'s extension decides the format (OpenProject #1209) unless \`format\` overrides it; the result is GitHub-flavored Markdown, ready to hand to the markdown editor or POST as a new page's \`content\` — this endpoint only converts, it does not save anything.\n\n\`format: 'markdown'\` (OpenProject #1092) is a pass-through — the file's own bytes, with a leading YAML front-matter block (if any) split off into \`title\`/\`description\`/\`tags\` — and needs no Pandoc extension. Every other format still needs Pandoc, and answers 503 without it. \`path\` is not written to, only checked: converting content requires \`write:pages\` on wherever the caller says they intend to save it.`,
        tags: ['Pages'],
        consumes: ['*/*'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            fileName: {
              type: 'string',
              minLength: 1,
              description:
                "The uploaded file's own name, used to detect its format from its extension (OpenProject #1209)."
            },
            format: {
              type: 'string',
              enum: [...SUPPORTED_IMPORT_FORMATS],
              description:
                'Overrides the format detected from `fileName`. Only needed when detection got it wrong or the extension is ambiguous.'
            },
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description:
                'Where the converted content would be saved. Used only to check permission — nothing is written here.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          },
          required: ['fileName', 'path']
        },
        response: {
          200: { $ref: 'PageImportResult#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Importing a page requires a logged in user.')
      }
      if (
        !mayOnPage(req, 'write:pages', req.params.siteId, {
          path: req.query.path,
          locale: req.query.locale ?? defaultLocale(req.params.siteId)
        })
      ) {
        return reply.forbidden('You are not allowed to write a page here.')
      }
      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        return reply.badRequest('No file was sent.')
      }
      const format = req.query.format || detectImportFormat(req.query.fileName)
      if (!format) {
        return reply.badRequest(
          `Could not detect an import format from '${req.query.fileName}'. Pass 'format' explicitly.`
        )
      }
      const result = await WIKI.models.pageImport.convertToMarkdown({
        format,
        data
      })
      return {
        ok: true,
        message: 'File converted successfully.',
        markdown: result.markdown,
        title: result.title,
        description: result.description,
        tags: result.tags
      }
    }
  )

  /**
   * IMPORT PAGES (BATCH)
   */
  app.post<{
    Params: { siteId: string }
    Querystring: { path: string; locale?: string }
  }>(
    '/sites/:siteId/pages/import/batch',
    {
      /*
        No route-level `permissions`: same reasoning as IMPORT PAGE CONTENT above — `write:pages` is
        granted by a group's page RULES, checked in the handler against the declared `path`.
      */
      schema: {
        summary: 'Convert several uploaded files to Markdown in one request',
        description: `A \`multipart/form-data\` sibling of \`POST .../pages/import\` (OpenProject #849): several files in one request (field name \`files\`, repeated), each file's format autodetected from its own extension (OpenProject #1209; field name \`formats\`, repeated in the same order as \`files\`, overrides a single file's detection when non-empty). At most ${MAX_IMPORT_BATCH_FILES} files, each at most ${Math.round(MAX_IMPORT_SIZE / 1024 / 1024)} MB, and at most ${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB combined (OpenProject #2204) — a batch over that aggregate ceiling is refused outright (400), not partially converted. The response carries one result per file, in the order they were sent — a bad file in the batch does not stop the rest from converting, so check each entry's own \`ok\`. Convert-only, exactly like the single-file endpoint: nothing is saved here, which is what lets the caller assign each result its own destination and review it before saving.\n\n\`format: 'markdown'\` (OpenProject #1092) is a pass-through and needs no Pandoc extension — every other format still does, and answers 503 without it. A file whose extension is not recognized fails only its own entry, same as any other per-file conversion failure. \`path\` is not written to, only checked: converting content requires \`write:pages\` on wherever the caller says they intend to save it.`,
        tags: ['Pages'],
        consumes: ['multipart/form-data'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description:
                'Where the converted content would be saved. Used only to check permission — nothing is written here.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          },
          required: ['path']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              results: {
                type: 'array',
                items: { $ref: 'PageImportBatchItem#' }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Importing a page requires a logged in user.')
      }
      if (
        !mayOnPage(req, 'write:pages', req.params.siteId, {
          path: req.query.path,
          locale: req.query.locale ?? defaultLocale(req.params.siteId)
        })
      ) {
        return reply.forbidden('You are not allowed to write a page here.')
      }

      /*
        Read every part off the request before converting any file: `req.parts()` is a streaming
        iterator over the one multipart body, and its next part is only available once the current
        one has been consumed (`@fastify/busboy`'s own constraint) — so buffering has to happen one
        part at a time, in the order they arrived, before conversion can run in parallel below.
        `req.files()` won't do here since it skips field parts entirely, and a per-file format
        override (OpenProject #1209) travels as a `formats` field the frontend interleaves right
        after its own file — the last-pushed upload is always the one it belongs to. A file's
        oversize is checked via `file.truncated` after `toBuffer()` resolves, not by catching a
        throw — see the `throwFileSizeLimit: false` comment on the plugin registration above for why
        letting an oversized file throw here would still fail the whole batch anyway.

        `MAX_IMPORT_BATCH_BYTES` bounds the total across every file combined (OpenProject #2204):
        `fileSize`/`MAX_IMPORT_SIZE` above only cap ONE file, so nothing previously stopped
        `MAX_IMPORT_BATCH_FILES` maximum-size files (~500 MB) from all being resident as `Buffer`s at
        once. Tripping it discards whatever had been buffered so far and stops accepting more —
        atomically refusing the whole request rather than converting the files that fit before the
        ceiling was crossed, which is what keeps this a hard cap rather than a soft one an attacker
        could still push past by spreading a large batch across many small file reads. The rest of
        the body is still drained (each further file read and immediately discarded, never buffered)
        rather than abandoned mid-stream, which would otherwise leave the connection holding
        unconsumed bytes.
      */
      const uploads: (
        | { fileName: string; data: Buffer; formatOverride: string }
        | { fileName: string; error: string }
      )[] = []
      let totalBytes = 0
      let overBudget = false
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const data = await part.toBuffer()
          if (overBudget) {
            continue
          }
          totalBytes += data.length
          if (totalBytes > MAX_IMPORT_BATCH_BYTES) {
            overBudget = true
            uploads.length = 0
            continue
          }
          if (part.file.truncated) {
            uploads.push({
              fileName: part.filename,
              error: 'This file is larger than the import limit.'
            })
          } else {
            uploads.push({ fileName: part.filename, data, formatOverride: '' })
          }
          continue
        }
        const last = uploads.at(-1)
        if (
          !overBudget &&
          part.fieldname === 'formats' &&
          last &&
          !('error' in last) &&
          typeof part.value === 'string'
        ) {
          last.formatOverride = part.value
        }
      }
      if (overBudget) {
        return reply.badRequest(
          `This batch is larger than the ${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB aggregate limit for one import request.`
        )
      }
      if (uploads.length < 1) {
        return reply.badRequest('No files were sent.')
      }

      const results = await Promise.all(
        uploads.map(async (upload) => {
          if ('error' in upload) {
            return { fileName: upload.fileName, ok: false, message: upload.error }
          }
          const format = upload.formatOverride || detectImportFormat(upload.fileName)
          if (!format) {
            return {
              fileName: upload.fileName,
              ok: false,
              message: `Could not detect an import format from '${upload.fileName}'.`
            }
          }
          try {
            const result = await WIKI.models.pageImport.convertToMarkdown({
              format,
              data: upload.data
            })
            return {
              fileName: upload.fileName,
              ok: true,
              markdown: result.markdown,
              title: result.title,
              description: result.description,
              tags: result.tags
            }
          } catch (err: any) {
            return {
              fileName: upload.fileName,
              ok: false,
              message: err.message || 'This file could not be converted.'
            }
          }
        })
      )

      return {
        ok: true,
        message: `${results.filter((r) => r.ok).length} of ${results.length} file(s) converted successfully.`,
        results
      }
    }
  )
}

export default routes
