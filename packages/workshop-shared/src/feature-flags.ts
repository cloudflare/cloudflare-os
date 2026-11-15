type UiFeatureFlagDefinition = {
  key: string;
  dev: boolean;
  default: boolean;
};

/** UI feature flags resolved by `workshop-backend` for `workshop-frontend`. */
export const UI_FEATURE_FLAGS = [
  // Replace this placeholder with the first real feature flag.
  { key: "placeholder-flag", dev: false, default: false },
] as const satisfies readonly UiFeatureFlagDefinition[];

type UiFeatureFlag = (typeof UI_FEATURE_FLAGS)[number];

/** Valid keys accepted by `useUiFeatureFlag()`. */
export type UiFeatureFlagName = UiFeatureFlag["key"];

/** Resolved boolean values for every registered UI feature flag. */
export type UiFeatureFlags = Record<UiFeatureFlagName, boolean>;

/** Flag values used by local Workshop development. */
export const DEV_UI_FEATURE_FLAGS = Object.fromEntries(
  UI_FEATURE_FLAGS.map((flag) => [flag.key, flag.dev] as const),
) as UiFeatureFlags;

/** Flag values used when Flagship is unavailable or unconfigured. */
export const DEFAULT_UI_FEATURE_FLAGS = Object.fromEntries(
  UI_FEATURE_FLAGS.map((flag) => [flag.key, flag.default] as const),
) as UiFeatureFlags;
