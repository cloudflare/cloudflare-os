import type { RpcStub } from "capnweb";
import type { AiChatAuthorInfo, AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "./rpcErrors";

// This browser's copy of the user's preferred model, which lets a picker start on it without
// waiting on the server. The server's copy is the one that follows the user between browsers.
//
// Browser storage outlives a session, so each name below is stored under the ID of the user it
// belongs to, and is read only for a user the server has confirmed: with no user, reads find
// nothing and writes are dropped. All of it is best-effort, since storage can be full or blocked.
const SELECTED = "lastSelectedModel";
// Set while the choice above has yet to be saved to the server, to a value naming the pick, so
// that only the save of that very pick clears it.
const UNSAVED = "lastSelectedModelUnsaved";
const NAMES = [SELECTED, UNSAVED];
// What browsers stored, for whoever used them, before any of it was kept per user.
const LEGACY_SYNCED = "lastSelectedModelSynced";
const LEGACY_KEYS = [SELECTED, LEGACY_SYNCED, "cachedModels"];

function read(name: string, userId: string | undefined): string | null {
  if (userId === undefined) return null;
  try {
    return localStorage.getItem(`${name}:${userId}`);
  } catch {
    return null;
  }
}

/** Removes every user's stored entries, apart from those of `userId` if given. */
function forgetOthers(userId?: string): void {
  for (const key of Object.keys(localStorage)) {
    const name = NAMES.find((candidate) => key.startsWith(`${candidate}:`));
    if (name !== undefined && key !== `${name}:${userId}`) localStorage.removeItem(key);
  }
}

function write(name: string, userId: string | undefined, value: string | null): void {
  if (userId === undefined) return;
  try {
    if (value === null) {
      localStorage.removeItem(`${name}:${userId}`);
    } else {
      // A shared browser keeps one user's entries, rather than gathering everyone's.
      forgetOthers(userId);
      localStorage.setItem(`${name}:${userId}`, value);
    }
  } catch {
    // The server's copy then stands in for this browser's.
  }
}

// The models this page last saw offered, and to whom. Kept for the page's lifetime only, which is
// as long as a picker can start on them: a newly loaded page has no confirmed user to read for.
let cachedModels: { userId: string; models: AiChatAuthorInfo[] } | undefined;

/** Forgets what this browser remembers of anyone's models, as when a user signs out. */
export function forgetModelSelection(): void {
  cachedModels = undefined;
  try {
    forgetOthers();
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // Nothing more to be done. Per-user entries are still read only for their own user, though
    // any from before entries were kept per user go to the next user confirmed here.
  }
}

/**
 * Hands what a browser stored before entries were kept per user to `userId`, the first user
 * confirmed in it since, unless they already have a choice of their own.
 */
function adoptLegacySelection(userId: string): void {
  try {
    const selected = localStorage.getItem(SELECTED);
    if (selected !== null && read(SELECTED, userId) === null) {
      write(SELECTED, userId, selected);
      // An unsynced choice predates picks being saved for the user, so it is newer than the
      // server's, which dates from onboarding.
      if (localStorage.getItem(LEGACY_SYNCED) === null) write(UNSAVED, userId, "1");
    }
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // The server's preference then applies.
  }
}

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
 * The models this page last saw offered to `userId`, or none if it has seen none. A picker starts
 * on these, so that it shows the user's model at once, and replaces them when the server answers.
 */
export function getCachedModels(userId: string | undefined): AiChatAuthorInfo[] {
  return cachedModels !== undefined && cachedModels.userId === userId ? cachedModels.models : [];
}

/** Remembers the models offered to `userId` for getCachedModels(). */
export function cacheModels(userId: string | undefined, models: AiChatAuthorInfo[]): void {
  if (userId !== undefined) cachedModels = { userId, models };
}

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

/** The model a new chat of `userId`'s starts on: their remembered choice, if still offered. */
export function getStoredSelectedModel(
  userId: string | undefined,
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = read(SELECTED, userId);

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
 * meanwhile, then reads getStoredSelectedModel() again once this settles, for the user whose ID
 * this resolves to. It never rejects: when the server can't be reached, the browser's own copy
 * stands, and the ID is undefined if the user couldn't be confirmed either.
 *
 * The server holds "No agent" as no preference, so other browsers keep their own choice rather than
 * following it, and a new external conversation starts on the first model offered.
 */
export async function syncSelectedModel(api: RpcStub<AuthenticatedApi>): Promise<string | undefined> {
  let userId: string | undefined;
  try {
    const revision = selectionRevision;
    // Asked together, so that knowing whose storage to read costs no round trip of its own.
    const identity = api.whoami();
    const reading = inOrder(() => api.getPreferredModel());
    reading.catch(() => {});
    userId = (await identity).id;
    adoptLegacySelection(userId);

    const local = read(SELECTED, userId);
    const unsaved = read(UNSAVED, userId);
    let answer: string | null;
    if (local !== null && unsaved !== null) {
      try {
        await inOrder(() => api.setPreferredModel(fromModelSelectValue(local)));
        if (read(UNSAVED, userId) === unsaved) write(UNSAVED, userId, null);
        return userId;
      } catch (err) {
        // A model that no longer resolves is refused; the server's preference, once it has been
        // read, then applies.
        logRpcFailure("Failed to save this browser's model choice:", err);
        answer = await reading;
        if (read(UNSAVED, userId) === unsaved) write(UNSAVED, userId, null);
      }
    } else {
      answer = await reading;
    }

    // A pick made while this was in flight, here or in another tab, is newer than the answer, as
    // is one whose save failed meanwhile, which the next sync saves.
    const overtaken = selectionRevision !== revision || read(SELECTED, userId) !== local ||
        read(UNSAVED, userId) !== null;
    if (answer !== null && !overtaken) write(SELECTED, userId, answer);
  } catch (err) {
    logRpcFailure("Failed to load the preferred model:", err);
  }
  return userId;
}

/**
 * Remembers a model choice of `userId`'s in this browser alone, for a caller that saves it to the
 * server itself.
 */
export function cacheSelectedModel(userId: string | undefined, modelId: string | null): void {
  selectionRevision++;
  write(SELECTED, userId, toModelSelectValue(modelId));
  write(UNSAVED, userId, null);
}

/** Remembers a model choice as `userId`'s preferred model, in this browser and on the server. */
export function persistSelectedModel(
  api: RpcStub<AuthenticatedApi>,
  userId: string | undefined,
  modelId: string | null,
): void {
  cacheSelectedModel(userId, modelId);
  // Until the save lands, so that a sync neither replaces the choice nor fails to retry it.
  const pick = crypto.randomUUID();
  write(UNSAVED, userId, pick);
  inOrder(() => api.setPreferredModel(modelId)).then(() => {
    if (read(UNSAVED, userId) === pick) write(UNSAVED, userId, null);
  }, (err: unknown) => {
    logRpcFailure("Failed to save the preferred model:", err);
  });
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
