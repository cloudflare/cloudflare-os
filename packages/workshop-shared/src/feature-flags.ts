type UiFeatureFlagDefinition = {
  key: string;
  dev: boolean;
  default: boolean;
};

/** UI feature flags resolved by `workshop-backend` for `workshop-frontend`. */
export const UI_FEATURE_FLAGS = [
  // The new Workshop UI (`workshop-app`) instead of `workshop-frontend`, switched by
  // `UI_VARIANT_COOKIE`.
  { key: "workshop-app", dev: false, default: false },
] as const satisfies readonly UiFeatureFlagDefinition[];

/**
 * The cookie that asks a backend serving the Workshop's pages itself for the new UI's page. A hint
 * for which page to send, not a permission: the old UI sets it once the `workshop-app` flag is on,
 * and the new UI clears it once the flag has been read as off.
 */
export const UI_VARIANT_COOKIE = "cfos-ui";

/** The value of `UI_VARIANT_COOKIE` that asks for the new UI. */
export const NEXT_UI_VARIANT = "next";

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
