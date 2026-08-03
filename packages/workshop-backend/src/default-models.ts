import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { getAiGatewayConfig } from "./ai-gateway.js";
import type { UserAiModelRecord } from "./user.js";

/**
 * Models to pre-populate for a newly created user account.
 *
 * Instances provisioned by the internal deploy wizard ship a WORKERS_AI binding, so Workers AI
 * inference works out of the box — but without AI Gateway mode (the "skip billing setup" path)
 * the model list would start empty and the user would have to add the Workers AI models by hand.
 * Instead, seed the suggested Workers AI models as ordinary per-user records: they resolve through
 * the normal direct path (getModelDirect only needs the WORKERS_AI binding), they're deletable,
 * and other providers remain manually addable.
 *
 * Gated on DEPLOY_URL (set only by the deploy wizard) so dev and self-hosted deployments are
 * unaffected, and skipped in AI Gateway mode, where the same models are already provided as
 * gateway virtuals (listModels would dedup stored copies anyway).
 */
export function defaultModelSeeds(env: Cloudflare.Env): UserAiModelRecord[] {
  if (!env.DEPLOY_URL || getAiGatewayConfig(env) !== null) return [];

  return Object.entries(SUGGESTED_MODELS.cloudflare).map(([id, name]) => ({
    profile: { type: "agent", id, name },
    config: { provider: "cloudflare", model: id, apiToken: "" },
  }));
}
