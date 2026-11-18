import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_FEATURE_FLAGS, UI_FEATURE_FLAGS } from '@gadgets/workshop-shared/feature-flags'
import { uiFeatureFlagsOf } from './FeatureFlagsContext'

const [first] = UI_FEATURE_FLAGS

describe('uiFeatureFlagsOf', () => {
  it('is the defaults when nothing was read', () => {
    expect(uiFeatureFlagsOf(undefined)).toEqual(DEFAULT_UI_FEATURE_FLAGS)
  })

  it('takes what the backend said of each flag', () => {
    expect(uiFeatureFlagsOf({ [first.key]: !first.default })[first.key]).toBe(!first.default)
  })

  it('leaves out flags the app does not know, and keeps the default for a value that is not one', () => {
    const flags = uiFeatureFlagsOf({ 'not-a-flag': true, [first.key]: 'yes' })
    expect(flags).toEqual(DEFAULT_UI_FEATURE_FLAGS)
    expect(Object.keys(flags)).not.toContain('not-a-flag')
  })
})
