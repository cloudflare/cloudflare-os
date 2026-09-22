import { describe, expect, it } from 'vitest'
import { actionErrorDiagnostics } from './useResolveAction'

describe('actionErrorDiagnostics', () => {
  it('includes standard error fields, but not attached request data', () => {
    const error = Object.assign(new Error('gatekeeper failed'), { requestBody: 'secret' })
    const diagnostics = JSON.parse(actionErrorDiagnostics(error, {
      actionId: 42,
      decision: 'approve',
    }))

    expect(diagnostics).toMatchObject({
      operation: 'approve-action',
      actionId: 42,
      error: { type: 'Error', message: 'gatekeeper failed' },
    })
    expect(diagnostics.error.stack).toContain('gatekeeper failed')
    expect(JSON.stringify(diagnostics)).not.toContain('secret')
  })
})
