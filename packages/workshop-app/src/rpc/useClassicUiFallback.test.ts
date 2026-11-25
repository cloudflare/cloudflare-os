import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_FEATURE_FLAGS, NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from '@gadgets/workshop-shared/feature-flags'
import { classicUiFallbackNeeded } from './useClassicUiFallback'

const OFF = { ...DEFAULT_UI_FEATURE_FLAGS, 'workshop-app': false }
const ON = { ...DEFAULT_UI_FEATURE_FLAGS, 'workshop-app': true }
const COOKIES = `a=b; ${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}; c=d`

describe('classicUiFallbackNeeded', () => {
  it('falls back once the flag is read as off and the cookie is set', () => {
    expect(classicUiFallbackNeeded({ flags: OFF, read: true }, COOKIES)).toBe(true)
  })

  it('stays while the flag is on', () => {
    expect(classicUiFallbackNeeded({ flags: ON, read: true }, COOKIES)).toBe(false)
  })

  it('stays when the flags could not be read, whatever their defaults', () => {
    expect(classicUiFallbackNeeded({ flags: OFF, read: false }, COOKIES)).toBe(false)
  })

  it('stays without the cookie, as on a preview', () => {
    expect(classicUiFallbackNeeded({ flags: OFF, read: true }, 'a=b')).toBe(false)
    expect(classicUiFallbackNeeded({ flags: OFF, read: true }, '')).toBe(false)
  })
})
