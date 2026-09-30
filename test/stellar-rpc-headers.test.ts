// Issue #284: custom STELLAR_RPC_HEADERS must actually reach `new rpc.Server()`,
// not just parse correctly in isolation. Uses vi.doMock + a fresh dynamic
// import since src/stellar/rpc.ts constructs its `server` singleton once at
// module-load time from the already-resolved `config` singleton.
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('rpc.Server header wiring (#284)', () => {
  afterEach(() => {
    vi.doUnmock('../src/config.js')
    vi.doUnmock('@stellar/stellar-sdk')
    vi.resetModules()
  })

  it('passes parsed STELLAR_RPC_HEADERS into the rpc.Server constructor', async () => {
    vi.resetModules()
    vi.doMock('../src/config.js', () => ({
      config: {
        stellar: {
          rpcUrl: 'https://rpc.example.com',
          rpcHeaders: { 'X-API-Key': 'secret-value' },
        },
      },
    }))

    const ServerSpy = vi.fn()
    vi.doMock('@stellar/stellar-sdk', () => ({
      rpc: { Server: ServerSpy },
    }))

    await import('../src/stellar/rpc.js')

    expect(ServerSpy).toHaveBeenCalledWith(
      'https://rpc.example.com',
      expect.objectContaining({ headers: { 'X-API-Key': 'secret-value' } })
    )
  })

  it('omits the headers option entirely when none are configured', async () => {
    vi.resetModules()
    vi.doMock('../src/config.js', () => ({
      config: {
        stellar: {
          rpcUrl: 'https://rpc.example.com',
          rpcHeaders: {},
        },
      },
    }))

    const ServerSpy = vi.fn()
    vi.doMock('@stellar/stellar-sdk', () => ({
      rpc: { Server: ServerSpy },
    }))

    await import('../src/stellar/rpc.js')

    const [, opts] = ServerSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(opts).not.toHaveProperty('headers')
  })
})
