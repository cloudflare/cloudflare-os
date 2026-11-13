import type { AiChatMetadata } from "@gadgets/workshop-shared/api";

type Placed = Pick<AiChatMetadata, "pinned" | "folder">;

/** A chat list split into Pinned, each folder (by name, in name order), and Other. */
export type OrganizedChats<C> = {
  pinned: C[];
  folders: { name: string; chats: C[] }[];
  other: C[];
};

const byName = (a: string, b: string) => a.localeCompare(b);

/**
 * Splits `chats` by their pins and folders (see AiChatMetadata.pinned and .folder), keeping their
 * order within each part. A pinned chat shows only under Pinned, though it stays in its folder.
 * Returns null when nothing is pinned or filed, so an unarranged list renders exactly as it did
 * before, unless `keepSections` asks for the sections anyway (a first folder is being named).
 */
export const organizeChats = <C extends Placed>(
  chats: readonly C[],
  keepSections = false,
): OrganizedChats<C> | null => {
  const pinned: C[] = [];
  const other: C[] = [];
  const folders = new Map<string, C[]>();
  for (const chat of chats) {
    if (chat.pinned) {
      pinned.push(chat);
    } else if (chat.folder === undefined) {
      other.push(chat);
    } else {
      const inFolder = folders.get(chat.folder);
      if (inFolder) inFolder.push(chat);
      else folders.set(chat.folder, [chat]);
    }
  }
  if (!keepSections && pinned.length === 0 && folders.size === 0) return null;
  return {
    pinned,
    folders: [...folders.keys()].toSorted(byName).map((name) => ({ name, chats: folders.get(name)! })),
    other,
  };
};

/** Every folder the chats are filed under, in name order, pinned chats' folders included. */
export const chatFolderNames = (chats: readonly Placed[]) =>
  [...new Set(chats.flatMap((chat) => chat.folder ?? []))].toSorted(byName);

/**
 * Counts the chats whose rows would say Working (an agent is running) or, failing that, Pending
 * changes, so a collapsed section can still show that something inside needs a look.
 */
export const countChatStatuses = (
  chats: readonly Pick<AiChatMetadata, "activeAgent" | "proposedChangeWorkpieces">[],
) => {
  let working = 0;
  let pending = 0;
  for (const chat of chats) {
    if (chat.activeAgent) working++;
    else if (chat.proposedChangeWorkpieces?.length) pending++;
  }
  return { working, pending };
};
