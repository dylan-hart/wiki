import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { buildClient } from './storage.ts'

/**
 * `storage.test.ts` mocks `S3Client.prototype.send` directly (via `aws-sdk-client-mock`), which never
 * exercises the SDK's own endpoint-resolution middleware — so it cannot tell a request that would
 * actually reach `minio.example.com` apart from one that would reach the nonexistent host
 * `my-bucket.minio.example.com`. This is precisely the failure upstream #1472 ("S3 storage not
 * compatible with Minio without s3ForcePathStyle option") reported: MinIO, and most self-hosted
 * S3-compatible servers, has no wildcard DNS record for `<bucket>.<host>`, so a virtual-hosted-style
 * request never reaches the server at all — it fails to resolve before a single byte is sent.
 *
 * This file is kept separate from `storage.test.ts` deliberately: importing `aws-sdk-client-mock`
 * there patches `S3Client.prototype.send` for every instance in that module, which would swallow the
 * fake `requestHandler` these tests install one layer lower (the transport a client hands a fully
 * resolved request to) to capture the real hostname/path the SDK builds — with no real network
 * involved. `node --test` runs each matched file as its own process, so the two files' client
 * patching never interacts.
 */

/** The real hostname/path an `S3Client` would send a request to, captured with no network involved. */
function captureRequest(config: Record<string, any>): Promise<{ hostname: string; path: string }> {
  let captured: { hostname: string; path: string } | undefined
  const requestHandler = {
    handle: async (request: any) => {
      captured = { hostname: request.hostname, path: request.path }
      return { response: { statusCode: 200, headers: {}, body: undefined } }
    },
    updateHttpClientConfig: () => {},
    httpHandlerConfigs: () => ({})
  }
  const client = buildClient({ ...config, mode: 'custom' })
  ;(client.config as any).requestHandler = requestHandler
  return client
    .send(new HeadBucketCommand({ Bucket: 'my-bucket' }))
    .catch(() => {})
    .then(() => captured!)
}

describe('s3 storage / real request shape against a non-AWS (MinIO-style) endpoint', () => {
  test('s3ForcePathStyle: true puts the bucket in the path, leaving the configured host untouched', async () => {
    const request = await captureRequest({
      endpoint: 'https://minio.example.com',
      s3ForcePathStyle: true,
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    assert.equal(request.hostname, 'minio.example.com')
    assert.equal(request.path, '/my-bucket/')
  })

  test('s3ForcePathStyle: false (the SDK default) prepends the bucket as a subdomain, which a self-hosted MinIO with no wildcard DNS cannot resolve', async () => {
    const request = await captureRequest({
      endpoint: 'https://minio.example.com',
      s3ForcePathStyle: false,
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    assert.equal(request.hostname, 'my-bucket.minio.example.com')
    assert.equal(request.path, '/')
  })
})
