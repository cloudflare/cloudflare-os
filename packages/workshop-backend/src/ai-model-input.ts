import type {Api, Model} from "@earendil-works/pi-ai";
import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import type {ModelHandle} from "./ai-models";

/** Resolve Ollama's per-model vision support before a chat opens image blobs or replays them. */
export async function resolveModelInput(
    handle: ModelHandle, config: AiModelConfig, signal: AbortSignal): Promise<void> {
  if (handle.model.provider !== "ollama") return;
  // Ollama names are user-defined, so a static model catalog cannot answer this. An unavailable
  // or older metadata endpoint leaves this turn text-only; immutable reads remain available
  // for a later turn/model. Never strand ordinary text chats on optional capability discovery.
  let input: Model<Api>["input"] = ["text"];
  try {
    const headers = new Headers(config.extraHeaders);
    if (config.apiToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${config.apiToken}`);
    }
    headers.set("Content-Type", "application/json");
    const response = await fetch(`${handle.model.baseUrl.replace(/\/v1$/, "")}/api/show`, {
      method: "POST", headers, body: JSON.stringify({model: config.model}), redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (response.ok) {
      const details = await response.json<{capabilities?: unknown}>();
      if (Array.isArray(details.capabilities) && details.capabilities.includes("vision")) {
        input = ["text", "image"];
      }
    } else await response.body?.cancel();
  } catch {
    signal.throwIfAborted();
  }
  handle.model = {...handle.model, input};
}

