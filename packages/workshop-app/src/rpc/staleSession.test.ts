import { describe, expect, it } from 'vitest'
import { PageUpdates, StaleBackend } from './staleSession'

describe('StaleBackend', () => {
  it('leaves a socket whose backend a new request no longer reaches', () => {
    const stale = new StaleBackend()
    expect(stale.leave('v1', 'v2')).toBe(true)
    expect(stale.hasLeft('v1')).toBe(true)
  })

  it('keeps a socket whose backend is the latest, or that could not be compared', () => {
    const stale = new StaleBackend()
    expect(stale.leave('v1', 'v1')).toBe(false)
    expect(stale.leave('v1', undefined)).toBe(false)
    expect(stale.leave(undefined, 'v2')).toBe(false)
    expect(stale.hasLeft('v1')).toBe(false)
  })

  it('leaves a version behind only once, so a rollout landing on either cannot loop it', () => {
    const stale = new StaleBackend()
    expect(stale.leave('v1', 'v2')).toBe(true)
    // The new socket landed on the old version again.
    expect(stale.leave('v1', 'v2')).toBe(false)
    expect(stale.leave('v2', 'v3')).toBe(true)
  })
})

describe('PageUpdates', () => {
  it('tells of a newer app once', () => {
    const updates = new PageUpdates()
    expect(updates.newer('build-a', 'build-b')).toBe(true)
    expect(updates.newer('build-a', 'build-b')).toBe(false)
  })

  it('tells of one newer still', () => {
    const updates = new PageUpdates()
    updates.newer('build-a', 'build-b')
    expect(updates.newer('build-a', 'build-c')).toBe(true)
  })

  it('says nothing while the page is the latest, or either cannot be read', () => {
    const updates = new PageUpdates()
    expect(updates.newer('build-a', 'build-a')).toBe(false)
    expect(updates.newer('build-a', undefined)).toBe(false)
    expect(updates.newer(undefined, 'build-b')).toBe(false)
  })
})
