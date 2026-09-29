import type { ChatApi } from "./chat-api";
import type { ChatSpaceInfo, ChatUser } from "./chat-types";

/**
 * Identify a direct message's other participant (`peer`) and name the DM after them.
 *
 * Chat itself names the members of a DM the account is in, so no further lookup is involved: when
 * Chat omits the name, the DM simply stays unnamed. Spaces and group chats return unchanged.
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
  const peer = peers.size === 1 ? [...peers.values()][0] : undefined;
  if (!peer) return info;
  return { ...info, peer, ...(!info.name && peer.name ? { name: peer.name } : {}) };
}
