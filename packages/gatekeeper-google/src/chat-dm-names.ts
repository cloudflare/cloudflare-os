import type { ChatApi } from "./chat-api";
import type { ChatSpaceInfo, ChatUser } from "./chat-types";

/**
 * Identify a direct message's other participant (`peer`) and name the DM after them.
 *
 * Chat may omit a member's display name, so a nameless person is looked up in the People API. That
 * name needs no observer check: anyone who can open a DM is one of its two participants.
 * Spaces and group chats return unchanged.
 */
export async function describeDirectMessage(
  api: ChatApi, info: ChatSpaceInfo, selfId: string,
): Promise<ChatSpaceInfo> {
  if (info.type !== "directMessage") return info;
  const peers = new Map<string, ChatUser>();
  let pageToken: string | undefined;
  // A DM has two participants; bound unexpected pagination rather than scanning a directory.
  for (let page = 0; page < 3; page++) {
    const result = await api.listMembers(info.id, pageToken ? { pageToken } : {});
    for (const membership of result.items) {
      if (membership.kind === "user" && membership.state === "joined" && membership.user.id !== selfId) {
        peers.set(membership.user.id, membership.user);
      }
    }
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  const found = peers.size === 1 ? [...peers.values()][0] : undefined;
  if (!found) return info;
  const name = found.name ?? (found.type === "human" ? await api.profileName(found.id) : undefined);
  const peer = name ? { ...found, name } : found;
  return { ...info, peer, ...(!info.name && name ? { name } : {}) };
}
