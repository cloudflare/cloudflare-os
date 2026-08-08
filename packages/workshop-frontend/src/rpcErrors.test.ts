// Vitest runs under node, but the src/ tsconfig only has browser types — hence the suppressions.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
// @ts-expect-error node builtin without @types/node
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { deserialize, serialize } from 'capnweb'
import { AUTH_ERROR_CODES, createAuthError } from '@gadgets/workshop-shared/api'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(site: string, err: unknown, options?: object) => void>() }))

import { reportIssue } from './errorReporting'
import {
  classifyRpcError, getDurableObjectId, isDurableObjectResetError, isOverloadedError,
  CONNECTION_MESSAGES, isTransientRpcError, logRpcFailure, reportDoResetError,
} from './rpcErrors'

const rpcError = (message: string, props?: object) => Object.assign(new Error(message), props)

// The reject frame observed in prod for a DO storage-timeout reset.
function storageTimeoutReset() {
  return rpcError(
    'Durable Object storage operation exceeded timeout which caused object to be reset.',
    { remote: true, overloaded: true, durableObjectReset: true, durableObjectId: 'eed0859e' },
  )
}

describe('classifyRpcError', () => {
  it('classifies reset flags as do-reset', () => {
    expect(classifyRpcError(storageTimeoutReset())).toBe('do-reset')
  })

  it('trusts the durableObjectReset flag over an unrecognized message', () => {
    expect(classifyRpcError(rpcError('internal error', { durableObjectReset: true }))).toBe('do-reset')
  })

  it('falls back to known reset messages without flags', () => {
    for (const message of [
      'Durable Object reset because its code was updated.',
      "Durable Object's isolate exceeded its memory limit and was reset.",
      'Durable Object exceeded its CPU time limit and was reset.',
      // What later calls on an already-dead capability reject with (flagless).
      'The execution context which hosts this callback is no longer running.',
    ]) {
      expect(classifyRpcError(new Error(message))).toBe('do-reset')
    }
  })

  it('prefers do-reset when both reset and retryable flags are set', () => {
    expect(classifyRpcError(rpcError('x', { durableObjectReset: true, retryable: true }))).toBe('do-reset')
  })

  it('classifies the retryable flag as do-reset (backend-side, not browser transport)', () => {
    expect(classifyRpcError(rpcError('x', { retryable: true }))).toBe('do-reset')
  })

  it('classifies capnweb transport messages as connection', () => {
    expect(classifyRpcError(new Error('Peer closed WebSocket: 1006 '))).toBe('connection')
    expect(classifyRpcError(new Error('WebSocket connection failed.'))).toBe('connection')
    expect(classifyRpcError(new Error('RPC session was shut down by disposing the main stub')))
        .toBe('connection')
    expect(classifyRpcError(new Error('Attempted to use RPC stub after it has been disposed.')))
        .toBe('connection')
  })

  it('classifies auth failures, which must never be retried or quieted', () => {
    // Coded errors are authoritative; bare messages are the fallback for older deployments.
    expect(classifyRpcError(createAuthError(AUTH_ERROR_CODES.invalidSessionToken))).toBe('auth')
    expect(classifyRpcError(rpcError('nope', { code: 'INVALID_SESSION_TOKEN' }))).toBe('auth')
    expect(classifyRpcError(new Error('invalid session token'))).toBe('auth')
    expect(classifyRpcError(new Error('Not authenticated with Access.'))).toBe('auth')
  })

  it('classifies everything else as other', () => {
    expect(classifyRpcError(new Error('Workspace not found.'))).toBe('other')
    expect(classifyRpcError('boom')).toBe('other')
    expect(classifyRpcError(null)).toBe('other')
    expect(classifyRpcError(undefined)).toBe('other')
  })
})

describe('isTransientRpcError', () => {
  it('is true for do-reset and connection, false otherwise', () => {
    expect(isTransientRpcError(storageTimeoutReset())).toBe(true)
    expect(isTransientRpcError(new Error('Peer closed WebSocket: 1006 '))).toBe(true)
    expect(isTransientRpcError(new Error('invalid session token'))).toBe(false)
    expect(isTransientRpcError(new Error('Workspace not found.'))).toBe(false)
  })
})

describe('flag accessors', () => {
  it('reads reset, overload, and DO id from the enriched error', () => {
    const err = storageTimeoutReset()
    expect(isDurableObjectResetError(err)).toBe(true)
    expect(isOverloadedError(err)).toBe(true)
    expect(getDurableObjectId(err)).toBe('eed0859e')
  })

  it('handles errors without flags', () => {
    expect(isOverloadedError(new Error('x'))).toBe(false)
    expect(getDurableObjectId(new Error('x'))).toBeUndefined()
    expect(getDurableObjectId(null)).toBeUndefined()
  })
})

describe('reportDoResetError', () => {
  it('forwards to reportIssue with a namespaced site', () => {
    const err = storageTimeoutReset()
    reportDoResetError('chat.send', err, { gadgetId: 'g1' })
    expect(reportIssue).toHaveBeenCalledWith('do-reset.chat.send', err,
        { severity: 'warning', handled: true, gadgetId: 'g1' })
  })
})

describe('logRpcFailure', () => {
  it('logs transient errors at debug level and returns true', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(logRpcFailure('failed:', storageTimeoutReset())).toBe(true)
      expect(debug).toHaveBeenCalledOnce()
      expect(error).not.toHaveBeenCalled()

      expect(logRpcFailure('failed:', new Error('Workspace not found.'))).toBe(false)
      expect(error).toHaveBeenCalledOnce()
    } finally {
      debug.mockRestore()
      error.mockRestore()
    }
  })
})

// Canary: these client-local errors carry no flags, so the classifier matches capnweb's message
// strings. Pin them to the installed build so an upgrade fails here, not silently in the UX.
describe('capnweb transport messages', () => {
  it('still exist in the installed capnweb build', () => {
    const require = createRequire(import.meta.url)
    const source = readFileSync(require.resolve('capnweb'), 'utf8')
    for (const message of CONNECTION_MESSAGES) {
      expect(source, `capnweb no longer raises "${message}"`).toContain(message)
    }
  })
})

// Canary: the classifier's primary path reads flags/codes off the deserialized error, so pin
// capnweb's custom-property round-trip too (serialize/deserialize use the same wire frame as
// RPC rejections). A regression here would silently demote every classification to the message
// fallback and drop auth codes entirely.
describe('capnweb error serialization', () => {
  it('round-trips the custom properties the classifier reads', () => {
    const sent = Object.assign(storageTimeoutReset(), { code: AUTH_ERROR_CODES.invalidSessionToken })
    const received = deserialize(serialize(sent)) as Error & Record<string, unknown>
    expect(received).toBeInstanceOf(Error)
    expect(received.durableObjectReset).toBe(true)
    expect(received.overloaded).toBe(true)
    expect(received.durableObjectId).toBe('eed0859e')
    expect(received.code).toBe(AUTH_ERROR_CODES.invalidSessionToken)
    expect(classifyRpcError(received)).toBe('do-reset')
  })
})
