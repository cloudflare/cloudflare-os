import { describe, expect, it } from 'vitest'
import { creditsUrl, outOfCreditsStep } from './credits'

describe('outOfCreditsStep', () => {
  it('asks for an account to bill until there is one', () => {
    expect(outOfCreditsStep({ connected: false })).toBe('connect')
    // Whatever else it says, nothing can be chosen of a connection there is not.
    expect(outOfCreditsStep({ connected: false, needsAccountSelection: true })).toBe('connect')
  })

  it('then for which of its accounts, where the connection has several', () => {
    expect(outOfCreditsStep({ connected: true, needsAccountSelection: true })).toBe('choose')
  })

  it('then for credits on the one that is billed', () => {
    expect(outOfCreditsStep({ connected: true })).toBe('topUp')
    expect(outOfCreditsStep({ connected: true, needsAccountSelection: false })).toBe('topUp')
  })
})

describe('creditsUrl', () => {
  it('goes straight to the account where it is known, and lets the dashboard ask otherwise', () => {
    expect(creditsUrl('abc123')).toBe('https://dash.cloudflare.com/?to=/abc123/ai/ai-gateway/credits')
    expect(creditsUrl(undefined)).toBe('https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/credits')
  })
})
