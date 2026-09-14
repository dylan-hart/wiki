import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Writable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { sendWebResponse, toWebRequest } from './webBridge.ts'

/**
 * `toWebRequest`/`sendWebResponse` are the two halves of the Fastify↔Web-Standard conversion
 * `mcp/http.ts` needs around `WebStandardStreamableHTTPServerTransport` (see `webBridge.ts`'s own doc
 * comment for why this exists rather than `@modelcontextprotocol/node`'s Node-native transport).
 * Exercised directly here, with no real Fastify app or transport involved — `mcp/http.test.ts`
 * already covers the end-to-end wiring through `app.inject()`.
 */
describe('mcp/webBridge', () => {
  describe('toWebRequest', () => {
    function requestStub(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
      return {
        method: 'POST',
        url: '/?foo=bar',
        protocol: 'https',
        hostname: 'wiki.example.com',
        headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
        ...overrides
      } as unknown as FastifyRequest
    }

    test('carries the method through', () => {
      const req = toWebRequest(requestStub({ method: 'DELETE' }))
      assert.equal(req.method, 'DELETE')
    })

    test('builds a well-formed absolute URL from protocol/hostname/url', () => {
      const req = toWebRequest(requestStub())
      assert.equal(req.url, 'https://wiki.example.com/?foo=bar')
    })

    test('copies single-valued headers through', () => {
      const req = toWebRequest(requestStub())
      assert.equal(req.headers.get('authorization'), 'Bearer token-a')
      assert.equal(req.headers.get('content-type'), 'application/json')
    })

    test('folds a repeated header into one comma-joined value, the same way Headers.append does', () => {
      // -> `x-multi`, not a well-known header name: Node's own `IncomingHttpHeaders` types most
      //    headers (`accept` included) as `string` and reserves `string | string[]` for the ones it
      //    knows can repeat (`set-cookie`) plus arbitrary/unknown names via its index signature.
      const req = toWebRequest(requestStub({ headers: { 'x-multi': ['one', 'two'] } }))
      assert.equal(req.headers.get('x-multi'), 'one, two')
    })

    test('skips a header Fastify reports as undefined rather than throwing', () => {
      const req = toWebRequest(
        requestStub({ headers: { 'mcp-session-id': undefined, accept: 'application/json' } })
      )
      assert.equal(req.headers.has('mcp-session-id'), false)
      assert.equal(req.headers.get('accept'), 'application/json')
    })

    test('carries no body — every call site passes the already-parsed body back through `parsedBody`', async () => {
      const req = toWebRequest(requestStub())
      assert.equal(req.body, null)
      assert.equal(await req.text(), '')
    })
  })

  describe('sendWebResponse', () => {
    /** A minimal Fastify-reply-shaped stand-in: `raw` is a real Writable, so `pipeline()` behaves exactly as it would against a genuine `http.ServerResponse`. */
    function replyStub() {
      const chunks: Buffer[] = []
      let head: { status: number; headers: Record<string, string> } | undefined
      const raw = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          cb()
        }
      }) as any
      raw.writeHead = (status: number, headers: Record<string, string>) => {
        head = { status, headers }
      }
      return {
        reply: { raw } as unknown as FastifyReply,
        get head() {
          return head
        },
        get body() {
          return Buffer.concat(chunks).toString('utf8')
        }
      }
    }

    test('writes the status and headers, and ends immediately for a bodyless response', async () => {
      // -> Not destructured: `head`/`body` are getters over state `writeHead`/the writable mutate
      //    DURING `sendWebResponse`, so they must be read off the stub afterwards, not captured at
      //    construction time.
      const stub = replyStub()
      await sendWebResponse(
        stub.reply,
        new Response(null, { status: 204, headers: { 'x-test': '1' } })
      )
      assert.equal(stub.head?.status, 204)
      assert.equal(stub.head?.headers['x-test'], '1')
      assert.equal(stub.body, '')
    })

    test('streams a chunked body through to completion', async () => {
      const stub = replyStub()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: one\n\n'))
          controller.enqueue(new TextEncoder().encode('data: two\n\n'))
          controller.close()
        }
      })
      const response = new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
      await sendWebResponse(stub.reply, response)
      assert.equal(stub.head?.status, 200)
      assert.equal(stub.head?.headers['content-type'], 'text/event-stream')
      assert.equal(stub.body, 'data: one\n\ndata: two\n\n')
    })
  })
})
