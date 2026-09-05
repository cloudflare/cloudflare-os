import { SUGGESTED_MODELS, type AiChatAuthorInfo, type AiModelConfig }
  from "@gadgets/workshop-shared/api";
import type { Api, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

/** Prefix for deployment-provided Team PI Codex model profile IDs. */
export const TEAM_PI_CODEX_PROFILE_PREFIX = "team-pi-codex/";

const DEFAULT_TEAM_PI_CODEX_MODELS = "gpt-6-astra";
const TEAM_PI_CODEX_CONFIG_URL = "internal:team-pi-codex";

/** A built-in model record resolved from deployment Team PI Codex configuration. */
export type TeamPiCodexModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
};

/** Return true when the deployment configured Team PI Codex routing. */
export function hasTeamPiCodexConfig(env: Cloudflare.Env): boolean {
  return !!env.TEAM_PI_CODEX_BASE_URL && !!env.TEAM_PI_CODEX_HMAC_SECRET;
}

/** Convert a built-in Team PI Codex profile ID into the raw provider model ID. */
export function parseTeamPiCodexProfileId(profileId: string): string | undefined {
  if (!profileId.startsWith(TEAM_PI_CODEX_PROFILE_PREFIX)) return undefined;
  const modelId = profileId.slice(TEAM_PI_CODEX_PROFILE_PREFIX.length);
  return modelId === "" ? undefined : modelId;
}

function configuredModelIds(env: Cloudflare.Env): string[] {
  const raw = env.TEAM_PI_CODEX_MODELS ?? DEFAULT_TEAM_PI_CODEX_MODELS;
  return [...new Set(raw.split(",").map(model => model.trim()).filter(model => model !== ""))];
}

function modelName(modelId: string): string {
  return SUGGESTED_MODELS.openai[modelId]?.name ?? `Team PI Codex ${modelId}`;
}

/** Return true when the authenticated user can use the internal Team PI model route. */
export function isTeamPiCodexUserId(userId: string): boolean {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@totango\.com$/.test(userId.toLowerCase());
}

/** Return true when a verified internal account can use the Team PI model route. */
export function isTeamPiCodexEligibleUser(
  userId: string,
  passwordLoginEnabled: boolean,
): boolean {
  return !passwordLoginEnabled && isTeamPiCodexUserId(userId);
}

/** List deployment-provided Team PI Codex models as public model profiles. */
export function getTeamPiCodexModelList(env: Cloudflare.Env): AiChatAuthorInfo[] {
  if (!hasTeamPiCodexConfig(env)) return [];
  return configuredModelIds(env).map(modelId => ({
    type: "agent",
    id: `${TEAM_PI_CODEX_PROFILE_PREFIX}${modelId}`,
    name: modelName(modelId),
  }));
}

/** Resolve the default deployment-provided Team PI Codex model for an internal user. */
export function getDefaultTeamPiCodexModel(
  env: Cloudflare.Env,
  userId: string,
): TeamPiCodexModelRecord | undefined {
  if (!isTeamPiCodexUserId(userId)) return undefined;
  const profile = getTeamPiCodexModelList(env)[0];
  return profile ? resolveTeamPiCodexModel(env, profile.id) : undefined;
}

/** Resolve a Team PI Codex built-in profile ID into its internal model config. */
export function resolveTeamPiCodexModel(
  env: Cloudflare.Env,
  profileId: string,
): TeamPiCodexModelRecord | undefined {
  if (!hasTeamPiCodexConfig(env)) return undefined;
  const modelId = parseTeamPiCodexProfileId(profileId);
  if (!modelId || !configuredModelIds(env).includes(modelId)) return undefined;
  const catalog = (OPENAI_CODEX_MODELS as Record<string, Model<Api>>)[modelId];
  const suggested = SUGGESTED_MODELS.openai[modelId];
  return {
    profile: { type: "agent", id: profileId, name: modelName(modelId) },
    config: {
      provider: "openai",
      model: modelId,
      apiToken: "",
      apiUrl: TEAM_PI_CODEX_CONFIG_URL,
      contextWindow: suggested?.contextWindow ?? catalog?.contextWindow ?? 128_000,
      outputLimit: suggested?.outputLimit ?? catalog?.maxTokens,
    },
  };
}

/** Return true when a model config carries the internal Team PI Codex marker. */
export function isTeamPiCodexMarkerConfig(config: AiModelConfig): boolean {
  return config.provider === "openai" && config.apiToken === "" &&
      config.apiUrl === TEAM_PI_CODEX_CONFIG_URL;
}

/** True when an internal model config names a currently configured Team PI Codex built-in. */
export function isTeamPiCodexConfig(env: Cloudflare.Env, config: AiModelConfig): boolean {
  return hasTeamPiCodexConfig(env) && isTeamPiCodexMarkerConfig(config) &&
      configuredModelIds(env).includes(config.model);
}
