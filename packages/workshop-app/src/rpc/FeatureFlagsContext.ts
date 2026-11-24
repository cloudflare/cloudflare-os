import { createContext, useContext } from 'react'
import { DEFAULT_UI_FEATURE_FLAGS, type UiFeatureFlagName, type UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'

export type FeatureFlagsState = {
  flags: UiFeatureFlags
  /** Not read yet: `flags` are the defaults meanwhile. */
  loading: boolean
  /** Whether `flags` are what the backend said, from this read or one before it, not the defaults. */
  read: boolean
}

/**
 * Which flags are known to the app, from what the backend said (`getUiFeatureFlags()`): each it
 * did not say, or said nothing true or false of, is its default.
 */
export const uiFeatureFlagsOf = (read: object | undefined): UiFeatureFlags =>
  Object.fromEntries(Object.entries(DEFAULT_UI_FEATURE_FLAGS).map(([name, fallback]) => {
    const value = (read as Record<string, unknown> | undefined)?.[name]
    return [name, typeof value === 'boolean' ? value : fallback]
  })) as UiFeatureFlags

const DEFAULTS: FeatureFlagsState = { flags: DEFAULT_UI_FEATURE_FLAGS, loading: true, read: false }

export const FeatureFlagsContext = createContext<FeatureFlagsState>(DEFAULTS)

/** The user's UI feature flags (`FeatureFlagsProvider`), the defaults until they are read. */
export const useUiFeatureFlags = () => useContext(FeatureFlagsContext)

/** Whether a part of the UI behind a flag is shown to the user, and whether that is known yet. */
export const useUiFeatureFlag = (name: UiFeatureFlagName) => {
  const { flags, loading } = useUiFeatureFlags()
  return { enabled: flags[name], loading }
}
