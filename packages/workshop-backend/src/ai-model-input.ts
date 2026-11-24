import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import type {ModelHandle} from "./ai-models";

// Bounded, isolate-local metadata only. Partition by endpoint/model/effective credentials without
// retaining secrets in cache keys; cache unknown results too, for older servers and proxies.
const visionCache = new Map<string, {vision: boolean | undefined; expires: number}>();
const CACHE_TTL = 60_000;

/** Resolve Ollama's per-model vision support before a chat opens image blobs or replays them. */
export async function resolveModelInput(
    handle: ModelHandle, config: AiModelConfig, signal: AbortSignal): Promise<void> {
  if (handle.model.provider !== "ollama") return;
  const headers = new Headers(config.extraHeaders);
  if (config.apiToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.apiToken}`);
  }
  headers.set("Content-Type", "application/json");
  const url = `${handle.model.baseUrl.replace(/\/v1$/, "")}/api/show`;
  const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify([url, config.model, [...headers]])))).toHex();
  signal.throwIfAborted();
  let result = visionCache.get(key);
  if (!result || result.expires <= Date.now()) {
    let vision: boolean | undefined;
    try {
      const response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify({model: config.model}), redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (response.ok) {
        const details = await response.json<{capabilities?: unknown}>();
        if (Array.isArray(details.capabilities) && details.capabilities.every(value => typeof value === "string")) {
          vision = details.capabilities.includes("vision");
        }
      } else await response.body?.cancel();
    } catch {
      signal.throwIfAborted();
    }
    result = {vision, expires: Date.now() + CACHE_TTL};
    if (visionCache.size >= 64) visionCache.delete(visionCache.keys().next().value!);
    visionCache.set(key, result);
  }
  // Only explicit metadata changes input support. Unknown preserves existing attachments on
  // OpenAI-compatible proxies and older Ollama servers that have no capability endpoint.
  if (result.vision !== undefined) {
    handle.model = {...handle.model, input: result.vision ? ["text", "image"] : ["text"]};
  }
}
