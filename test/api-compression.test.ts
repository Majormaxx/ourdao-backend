// Issue #282: @fastify/compress registered globally with a 1024-byte
// threshold, gzip + brotli support.
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'

describe('response compression (#282)', () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app?.close()
  })

  it('compresses a large JSON payload with gzip when requested', async () => {
    app = await buildServer()
    // A payload well past the 1024-byte threshold, standing in for a large
    // array response like /api/loans or /api/events.
    const largePayload = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, note: 'x'.repeat(20) })) }
    app.get('/__test/large', async () => largePayload)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/__test/large',
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    const decompressed = JSON.parse(gunzipSync(res.rawPayload).toString('utf-8'))
    expect(decompressed).toEqual(largePayload)
  })

  it('does not compress a response below the 1024-byte threshold', async () => {
    app = await buildServer()
    app.get('/__test/small', async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/__test/small',
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.json()).toEqual({ ok: true })
  })

  it('prefers brotli over gzip when the client accepts both', async () => {
    app = await buildServer()
    const largePayload = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, note: 'x'.repeat(20) })) }
    app.get('/__test/large-br', async () => largePayload)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/__test/large-br',
      headers: { 'accept-encoding': 'br, gzip' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
  })
})
