import type { ThinkingLevel } from "@gadgets/workshop-shared/api";
import { THINKING_LEVEL_ORDER } from "@gadgets/workshop-shared/thinking-level";

// Hands a thinking-level pick off across a full page navigation: the Home page composer
// (routes/index.tsx) creates a chat and picks a level for it, then navigates to the workspace
// page, which mounts an entirely separate ChatInterface instance with no memory of that choice.
// Within a single mounted ChatInterface, the same handoff (composing a new chat, then continuing
// it) instead moves an in-memory map entry -- see promoteThinkingLevelSelection() in
// ChatInterface.tsx -- because there's no unmount in between. This module exists only for the
// cross-navigation case, where sessionStorage is the only thing that survives the remount.
//
// Keyed per chat ID (not a single shared slot) so an in-flight pick can't leak onto some other
// chat if, say, two "start a new chat" tabs are open at once. Consumed exactly once: the reader
// deletes the entry so it can never apply twice.
const STORAGE_KEY_PREFIX = "pendingChatThinkingLevel:";

export function stashPendingChatThinkingLevel(chatId: number, level: ThinkingLevel): void {
  sessionStorage.setItem(STORAGE_KEY_PREFIX + chatId, level);
}

export function takePendingChatThinkingLevel(chatId: number): ThinkingLevel | undefined {
  const key = STORAGE_KEY_PREFIX + chatId;
  const value = sessionStorage.getItem(key);
  if (value === null) return undefined;
  sessionStorage.removeItem(key);
  // Defensive: a foreign or stale value (e.g. a future release renaming a level) should be
  // ignored rather than handed to the backend, which would reject it.
  return (THINKING_LEVEL_ORDER as string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}
