import type { RpcStub } from "capnweb";
import type { AiChatAuthorInfo, AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "./rpcErrors";

// This browser's copy of the user's preferred model, which lets a picker start on it without
// waiting on the server. The server's copy is the one that follows the user between browsers.
const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";
// Set once this browser's copy has been reconciled with the server's.
const PREFERENCE_SYNCED_KEY = "lastSelectedModelSynced";
const CACHED_MODELS_KEY = "cachedModels";

// Counts this page's picks, so that an answer to a read started before a pick is known to be stale.
let selectionRevision = 0;

// Preference requests run one at a time, so that they take effect in the order they were made
// however long the server takes over each.
let lastRequest: Promise<unknown> = Promise.resolve();
function inOrder<T>(request: () => Promise<T>): Promise<T> {
  const result = lastRequest.then(request, request);
  lastRequest = result;
  return result;
}

/**
 * The models this browser last saw offered, or none if it has seen none. A picker starts on these,
 * so that it shows the user's model at once, and replaces them when the server answers.
 */
export function getCachedModels(): AiChatAuthorInfo[] {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(CACHED_MODELS_KEY) ?? "[]");
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
}

/** Remembers the offered models for getCachedModels(). */
export function cacheModels(models: AiChatAuthorInfo[]): void {
  try {
    localStorage.setItem(CACHED_MODELS_KEY, JSON.stringify(models));
  } catch {
    // Only an optimisation: a picker then starts empty and waits on the server.
  }
}

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

/**
 * Brings this browser's remembered model in line with the user's preferred model, so that a new
 * chat starts on the model they last picked in any browser. A picker shows the browser's copy
 * meanwhile, then reads getStoredSelectedModel() again once this settles. It never rejects: when
 * the server can't be reached, the browser's own copy stands.
 *
 * The server holds "No agent" as no preference, so that choice stays in the browser that made it.
 */
export async function syncSelectedModel(api: RpcStub<AuthenticatedApi>): Promise<void> {
  try {
    const revision = selectionRevision;
    const local = localStorage.getItem(LAST_SELECTED_MODEL_KEY);
    if (local !== null && localStorage.getItem(PREFERENCE_SYNCED_KEY) === null) {
      // This browser's choice predates picks being saved for the user, so it is newer than the
      // server's, which dates from onboarding.
      try {
        await inOrder(() => api.setPreferredModel(fromModelSelectValue(local)));
        localStorage.setItem(PREFERENCE_SYNCED_KEY, "1");
        return;
      } catch (err) {
        // A model that no longer resolves is refused; the server's preference then applies.
        logRpcFailure("Failed to save this browser's model choice:", err);
      }
    }

    const preferred = await inOrder(() => api.getPreferredModel());
    // A pick made while this was in flight is newer than the answer.
    if (preferred !== null && selectionRevision === revision) {
      localStorage.setItem(LAST_SELECTED_MODEL_KEY, preferred);
    }
    localStorage.setItem(PREFERENCE_SYNCED_KEY, "1");
  } catch (err) {
    logRpcFailure("Failed to load the preferred model:", err);
  }
}

/** Remembers a model choice in this browser alone, for a caller that saves it to the server itself. */
export function cacheSelectedModel(modelId: string | null): void {
  selectionRevision++;
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
  localStorage.setItem(PREFERENCE_SYNCED_KEY, "1");
}

/** Remembers a model choice as the user's preferred model, in this browser and on the server. */
export function persistSelectedModel(
  api: RpcStub<AuthenticatedApi>,
  modelId: string | null,
): void {
  cacheSelectedModel(modelId);
  inOrder(() => api.setPreferredModel(modelId)).catch((err: unknown) => {
    logRpcFailure("Failed to save the preferred model:", err);
    // The next syncSelectedModel() then saves this browser's choice rather than replacing it.
    localStorage.removeItem(PREFERENCE_SYNCED_KEY);
  });
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
