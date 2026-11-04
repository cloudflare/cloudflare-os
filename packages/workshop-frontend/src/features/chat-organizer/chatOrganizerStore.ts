import { EMPTY_ORGANIZATION, type ChatOrganization } from "./chatOrganization";

// Pins and folders live in this browser only, per user and workspace, so the feature needs nothing
// from the kernel. Moving them server-side means replacing this module.

const STORAGE_PREFIX = "gadgets:chat-organizer:v1";

export const chatOrganizerStorageKey = (userId: string, workspaceId: string) =>
  `${STORAGE_PREFIX}:${userId}:${workspaceId}`;

const listeners = new Set<() => void>();
// useSyncExternalStore needs a stable snapshot, so each key's parse is reused until its raw value
// changes.
const snapshots = new Map<string, { raw: string | null; organization: ChatOrganization }>();

const parse = (raw: string | null): ChatOrganization => {
  if (raw === null) return EMPTY_ORGANIZATION;
  try {
    const value = JSON.parse(raw) as Partial<ChatOrganization> | null;
    return {
      folders: Array.isArray(value?.folders) ? value.folders : [],
      places: value?.places && typeof value.places === "object" ? value.places : {},
      otherHidden: value?.otherHidden === true,
    };
  } catch {
    return EMPTY_ORGANIZATION;
  }
};

export const readChatOrganization = (key: string): ChatOrganization => {
  const raw = localStorage.getItem(key);
  const cached = snapshots.get(key);
  if (cached && cached.raw === raw) return cached.organization;
  const organization = parse(raw);
  snapshots.set(key, { raw, organization });
  return organization;
};

/** Saves an arrangement. A storage error (a full quota) propagates: the change didn't happen. */
export const writeChatOrganization = (key: string, organization: ChatOrganization) => {
  localStorage.setItem(key, JSON.stringify(organization));
  for (const listener of listeners) listener();
};

export const subscribeToChatOrganization = (listener: () => void) => {
  listeners.add(listener);
  // Writes from other tabs arrive as storage events.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
